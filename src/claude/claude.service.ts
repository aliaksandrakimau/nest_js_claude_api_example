import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import {
  ChatRequestDto,
  ConversationRequestDto,
  SendMessageRequestDto,
  StreamRequestDto,
} from './dto';
import { ToolRegistryService } from './tools/tool-registry.service';
import { ModelRouterService } from './model-router.service';
import { PromptStoreService } from '../prompts/prompt-store.service';
import { ConversationStoreService } from '../conversations/conversation-store.service';
import type {
  ClaudeApiMessage,
  ClaudeModel,
  ClaudeRawStreamEvent,
  ClaudeResponse,
  ClaudeStreamEvent,
  UpstreamStream,
} from './interfaces';

const DEFAULT_MAX_TOKENS = 1000;
// Safety bound for the tool orchestration loop: a misbehaving model that
// keeps requesting tools cannot spin the conversation forever.
const MAX_TOOL_ROUNDS = 10;

@Injectable()
export class ClaudeService implements OnModuleInit {
  private client?: Anthropic;

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly logger: PinoLogger,
    private readonly config: ConfigService,
    private readonly promptStore: PromptStoreService,
    private readonly conversationStore: ConversationStoreService,
    private readonly modelRouter: ModelRouterService,
  ) {
    this.logger.setContext('ClaudeService');
  }

  // Fail fast at bootstrap instead of failing on the first request.
  onModuleInit(): void {
    if (!this.config.get<string>('ANTHROPIC_API_KEY')) {
      throw new Error('ANTHROPIC_API_KEY environment variable must be set');
    }
  }

  async sendMessage(request: SendMessageRequestDto): Promise<ClaudeResponse> {
    return this.createMessage({
      ...this.options(request),
      messages: [{ role: 'user', content: request.message }],
    });
  }

  async createConversation(
    request: ConversationRequestDto,
  ): Promise<ClaudeResponse> {
    return this.createMessage({
      ...this.options(request),
      messages: request.messages,
    });
  }

  // Streams the answer as normalized events: aggregated shapes reach the
  // consumer — message_start, text_delta, tool_use_*, thinking_*, and the
  // final message_stop with stopReason + usage. See streamRawMessage for the
  // unfiltered protocol.
  async *streamMessage(
    request: StreamRequestDto,
  ): AsyncGenerator<ClaudeStreamEvent> {
    const stream = await this.openStream(request);

    try {
      let stopReason: string | null = null;
      let inputTokens = 0;
      let outputTokens = 0;

      // Track active content blocks so we can emit typed stop events.
      const blocks = new Map<
        number,
        { type: string; id?: string; name?: string; json?: string }
      >();

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            inputTokens = event.message.usage.input_tokens;
            yield {
              type: 'message_start',
              id: event.message.id,
              model: event.message.model,
            };
            break;

          case 'content_block_start': {
            const block = event.content_block;
            const entry: { type: string; id?: string; name?: string } = {
              type: block.type,
            };
            if (block.type === 'tool_use') {
              entry.id = block.id;
              entry.name = block.name;
              blocks.set(event.index, entry);
              yield { type: 'tool_use_start', id: block.id, name: block.name };
            } else if (block.type === 'thinking') {
              blocks.set(event.index, entry);
            } else {
              blocks.set(event.index, entry);
            }
            break;
          }

          case 'content_block_delta': {
            const block = blocks.get(event.index);
            if (event.delta.type === 'text_delta') {
              yield { type: 'text_delta', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta' && block) {
              block.json = (block.json ?? '') + event.delta.partial_json;
              yield {
                type: 'tool_use_delta',
                partialJson: event.delta.partial_json,
              };
            } else if (event.delta.type === 'thinking_delta') {
              yield { type: 'thinking_delta', thinking: event.delta.thinking };
            } else if (event.delta.type === 'signature_delta') {
              yield { type: 'thinking_stop', signature: event.delta.signature };
            }
            break;
          }

          case 'content_block_stop': {
            const block = blocks.get(event.index);
            if (block?.type === 'tool_use') {
              let input: unknown;
              try {
                input = block.json ? JSON.parse(block.json) : {};
              } catch {
                input = block.json;
              }
              yield {
                type: 'tool_use_stop',
                id: block.id!,
                name: block.name!,
                input,
              };
            }
            blocks.delete(event.index);
            break;
          }

          case 'message_delta':
            stopReason = event.delta.stop_reason;
            outputTokens = event.usage.output_tokens;
            break;

          case 'message_stop':
            yield {
              type: 'message_stop',
              stopReason,
              usage: { inputTokens, outputTokens },
            };
            break;
        }
      }
    } finally {
      // Stop the upstream request even when the client disconnects mid-stream:
      // breaking out of the loop runs this block through generator return().
      stream.controller.abort();
    }
  }

  // Full agent loop over registered tools: streams normalized events to the
  // consumer while transparently running tool calls requested by the model.
  // Each round: open a stream with tools attached; if the model stops with
  // stop_reason 'tool_use', run every requested tool through the registry,
  // append assistant + tool_result turns to the history and start the next
  // round. The final message_stop carries usage summed across all rounds.
  // With a sessionId the history lives server-side: stored turns are loaded
  // up front and the completed exchange is appended afterwards, so clients
  // only ever send the newest message.
  async *streamWithTools(
    request: ChatRequestDto,
  ): AsyncGenerator<ClaudeStreamEvent> {
    if (!this.toolRegistry.hasTools()) {
      throw new BadRequestException(
        'No tools are registered; /chat requires at least one tool handler',
      );
    }
    if (request.message !== undefined && request.messages !== undefined) {
      throw new BadRequestException(
        'Provide either "message" or "messages", not both',
      );
    }
    const sessionId = request.sessionId;
    if (sessionId !== undefined) {
      if (request.messages !== undefined) {
        throw new BadRequestException(
          'Do not combine "sessionId" with "messages"; the history is kept server-side',
        );
      }
      if (request.message === undefined) {
        throw new BadRequestException('"sessionId" requires a "message"');
      }
    }

    let messages: ClaudeApiMessage[];
    if (sessionId !== undefined) {
      const history = this.conversationStore.getHistory(sessionId);
      messages = [...history, { role: 'user', content: request.message! }];
      yield { type: 'session', sessionId };
    } else {
      messages = request.messages ?? [
        { role: 'user', content: request.message ?? '' },
      ];
    }
    const tools = this.toolRegistry.getToolDefinitions();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      this.logger.debug({ round }, 'tool orchestration round starting');
      let upstream: UpstreamStream;
      try {
        upstream = await this.getClient().messages.create({
          ...this.options(request),
          messages,
          tools,
          stream: true,
        });
      } catch (error) {
        this.mapSdkError(error);
      }

      try {
        let stopReason: string | null = null;
        // Blocks of the assistant turn being streamed, replayed into history
        // when the model asks for tools next round.
        const assistantBlocks: ContentBlockParam[] = [];
        const pendingToolCalls: ToolUseBlockParam[] = [];
        const blockInputs = new Map<number, string>();
        // Maps upstream content-block index -> position in pendingToolCalls,
        // because block indices count text blocks too while the calls array
        // only holds tool_use entries.
        const blockToCall = new Map<number, number>();

        for await (const event of upstream) {
          switch (event.type) {
            case 'message_start':
              totalInputTokens += event.message.usage.input_tokens;
              yield {
                type: 'message_start',
                id: event.message.id,
                model: event.message.model,
              };
              break;

            case 'content_block_start':
              if (event.content_block.type === 'tool_use') {
                blockInputs.set(event.index, '');
                blockToCall.set(event.index, pendingToolCalls.length);
                pendingToolCalls.push({
                  type: 'tool_use',
                  id: event.content_block.id,
                  name: event.content_block.name,
                  input: {},
                });
                yield {
                  type: 'tool_use_start',
                  id: event.content_block.id,
                  name: event.content_block.name,
                };
              } else if (event.content_block.type === 'text') {
                assistantBlocks.push({
                  type: 'text',
                  text: '',
                });
              }
              break;

            case 'content_block_delta':
              if (event.delta.type === 'text_delta') {
                const textBlock = assistantBlocks[assistantBlocks.length - 1];
                if (textBlock?.type === 'text') {
                  textBlock.text += event.delta.text;
                }
                yield { type: 'text_delta', text: event.delta.text };
              } else if (event.delta.type === 'input_json_delta') {
                const accumulated =
                  (blockInputs.get(event.index) ?? '') +
                  event.delta.partial_json;
                blockInputs.set(event.index, accumulated);
                yield {
                  type: 'tool_use_delta',
                  partialJson: event.delta.partial_json,
                };
              } else if (event.delta.type === 'thinking_delta') {
                yield {
                  type: 'thinking_delta',
                  thinking: event.delta.thinking,
                };
              } else if (event.delta.type === 'signature_delta') {
                yield {
                  type: 'thinking_stop',
                  signature: event.delta.signature,
                };
              }
              break;

            case 'content_block_stop': {
              const rawJson = blockInputs.get(event.index);
              if (rawJson === undefined) {
                break;
              }
              blockInputs.delete(event.index);
              let parsedInput: unknown;
              try {
                parsedInput = rawJson ? JSON.parse(rawJson) : {};
              } catch {
                parsedInput = {};
              }
              const callPosition = blockToCall.get(event.index);
              if (callPosition !== undefined) {
                const call = pendingToolCalls[callPosition];
                call.input = parsedInput;
                yield {
                  type: 'tool_use_stop',
                  id: call.id,
                  name: call.name,
                  input: parsedInput,
                };
              }
              break;
            }

            case 'message_delta':
              stopReason = event.delta.stop_reason;
              totalOutputTokens += event.usage.output_tokens;
              break;

            case 'message_stop':
              // Emitted once, after the loop decides this is the final round.
              break;
          }
        }

        if (stopReason !== 'tool_use' || pendingToolCalls.length === 0) {
          // Persist the exchange so the next request with this sessionId
          // continues the conversation.
          if (sessionId !== undefined && request.message !== undefined) {
            const finalText = assistantBlocks
              .filter(
                (
                  block,
                ): block is Extract<ContentBlockParam, { type: 'text' }> =>
                  block.type === 'text',
              )
              .map((block) => block.text)
              .join('');
            this.conversationStore.appendTurn(
              sessionId,
              request.message,
              finalText,
            );
          }
          this.logger.info(
            {
              rounds: round + 1,
              stopReason,
              usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
              },
            },
            'claude chat completed',
          );
          yield {
            type: 'message_stop',
            stopReason,
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
            },
          };
          return;
        }

        // Replay the assistant turn (any text + every tool call) so the API
        // can correlate the tool results that follow in the next request.
        if (assistantBlocks.length > 0 || pendingToolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: [...assistantBlocks, ...pendingToolCalls],
          });
        }

        const toolResults: ToolResultBlockParam[] = [];
        for (const call of pendingToolCalls) {
          const result = await this.toolRegistry.dispatch(
            call.name,
            call.input as Record<string, unknown>,
          );
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: result,
          });
        }
        messages.push({ role: 'user', content: toolResults });
      } finally {
        // Cancel the current round's upstream request when the consumer
        // disconnects between rounds or mid-stream.
        upstream.controller.abort();
      }
    }

    this.logger.warn(
      { maxRounds: MAX_TOOL_ROUNDS },
      'tool orchestration exceeded the round limit',
    );
    throw new HttpException(
      ['Tool orchestration exceeded', MAX_TOOL_ROUNDS, 'rounds'].join(' '),
      HttpStatus.BAD_GATEWAY,
    );
  }

  // Streams the UNMODIFIED Anthropic protocol. Where streamMessage collapses
  // the wire format into three shapes, this yields every event the API emits:
  // message_start -> [content_block_start -> content_block_delta* ->
  // content_block_stop]* -> message_delta -> message_stop, plus ping
  // keepalives anywhere in between. Consumers must tolerate unknown event and
  // delta types — Anthropic extends the protocol without version bumps.
  async *streamRawMessage(
    request: StreamRequestDto,
  ): AsyncGenerator<ClaudeRawStreamEvent> {
    const stream = await this.openStream(request);

    try {
      // yield* delegates iteration unchanged — a pure pass-through.
      yield* stream;
    } finally {
      stream.controller.abort();
    }
  }

  // Shared prologue for both stream generators: enforce the XOR rule, build
  // the message list and open the upstream request. Everything here runs on
  // the generator's first pull, so validation errors surface before any byte
  // is written to the HTTP response.
  private async openStream(request: StreamRequestDto): Promise<UpstreamStream> {
    if (request.message !== undefined && request.messages !== undefined) {
      throw new BadRequestException(
        'Provide either "message" or "messages", not both',
      );
    }

    const messages: ClaudeApiMessage[] = request.messages ?? [
      { role: 'user', content: request.message ?? '' },
    ];

    try {
      return await this.getClient().messages.create({
        ...this.options(request),
        messages,
        stream: true,
      });
    } catch (error) {
      this.mapSdkError(error);
    }
  }

  async listModels(): Promise<ClaudeModel[]> {
    try {
      const response = await this.getClient().models.list();

      return response.data.map((model) => ({
        id: model.id,
        displayName: model.display_name,
        createdAt: model.created_at,
      }));
    } catch (error) {
      this.mapSdkError(error);
    }
  }

  private async createMessage(params: {
    messages: ClaudeApiMessage[];
    model: string;
    max_tokens: number;
    system?: string;
    temperature?: number;
  }): Promise<ClaudeResponse> {
    try {
      const response = await this.getClient().messages.create(params);

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const result = {
        id: response.id,
        model: response.model,
        role: response.role,
        text,
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
      this.logger.info(
        {
          model: result.model,
          stopReason: result.stopReason,
          usage: result.usage,
        },
        'claude message completed',
      );
      return result;
    } catch (error) {
      this.mapSdkError(error);
    }
  }

  // Resolves the effective system prompt: a stored prompt by name or the
  // inline text. The two sources are mutually exclusive so callers cannot
  // silently mix an outdated inline copy with the versioned store.
  private resolveSystem(
    request:
      | ConversationRequestDto
      | SendMessageRequestDto
      | StreamRequestDto
      | ChatRequestDto,
  ): string | undefined {
    if (request.promptName !== undefined && request.system !== undefined) {
      throw new BadRequestException(
        'Provide either "system" or "promptName", not both',
      );
    }
    return request.promptName !== undefined
      ? this.promptStore.get(request.promptName).text
      : request.system;
  }

  private options(
    request:
      | ConversationRequestDto
      | SendMessageRequestDto
      | StreamRequestDto
      | ChatRequestDto,
  ): {
    model: string;
    max_tokens: number;
    system?: string;
    temperature?: number;
  } {
    const system = this.resolveSystem(request);
    return {
      // The router keeps an explicit model override; otherwise it picks the
      // model from input heuristics (see ModelRouterService).
      model: this.modelRouter.selectModel(
        request.model,
        this.inputTextOf(request),
      ),
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    };
  }

  // Flattens whatever text the request carries into one string for the
  // router heuristics. `in`-narrowing because not every DTO has both fields.
  private inputTextOf(
    request:
      | ConversationRequestDto
      | SendMessageRequestDto
      | StreamRequestDto
      | ChatRequestDto,
  ): string {
    if ('message' in request && typeof request.message === 'string') {
      return request.message;
    }
    if ('messages' in request && Array.isArray(request.messages)) {
      return request.messages
        .map((message) =>
          typeof message.content === 'string' ? message.content : '',
        )
        .join(' ');
    }
    return '';
  }

  // Translate SDK failures into meaningful HTTP responses instead of leaking
  // raw 500s. Authentication problems are ours (the configured key), not the
  // caller's, so they surface as 503; caller mistakes like an unknown model
  // surface as 400; anything else from the API becomes 502.
  private mapSdkError(error: unknown): never {
    if (
      error instanceof AuthenticationError ||
      error instanceof PermissionDeniedError
    ) {
      this.logger.error(
        { sdkError: error.message },
        'Anthropic API rejected the configured key',
      );
      throw new ServiceUnavailableException(
        'Anthropic API rejected ANTHROPIC_API_KEY',
      );
    }

    if (error instanceof RateLimitError) {
      this.logger.warn({ sdkError: error.message }, 'Anthropic rate limit hit');
      throw new HttpException(
        'Anthropic rate limit exceeded, retry later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (
      error instanceof BadRequestError ||
      error instanceof NotFoundError ||
      error instanceof UnprocessableEntityError
    ) {
      throw new BadRequestException(error.message);
    }

    if (error instanceof APIConnectionError) {
      throw new ServiceUnavailableException(
        'Could not reach the Anthropic API',
      );
    }

    if (error instanceof APIError) {
      throw new HttpException(error.message, HttpStatus.BAD_GATEWAY);
    }

    throw error;
  }

  private getClient(): Anthropic {
    return (this.client ??= new Anthropic());
  }
}
