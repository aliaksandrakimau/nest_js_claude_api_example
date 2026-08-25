import type {
  ContentBlockParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleInit,
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
import { ProviderRegistryService } from './providers/provider-registry.service';
import type {
  ClaudeApiMessage,
  ClaudeModel,
  ClaudeRawStreamEvent,
  ClaudeResponse,
  ClaudeStreamEvent,
} from './interfaces';
import type {
  ProviderRequest,
  ProviderStreamEvent,
} from './providers/provider.interface';

const DEFAULT_MAX_TOKENS = 1000;
// Safety bound for the tool orchestration loop: a misbehaving model that
// keeps requesting tools cannot spin the conversation forever.
const MAX_TOOL_ROUNDS = 10;

// Provider-agnostic orchestration layer: routes each request to the provider
// that owns the requested model (native Anthropic or an OpenAI-compatible
// endpoint), keeps the tool loop, prompt/session handling and history format
// identical across providers. See providers/provider.interface.ts for the
// normalized contract every provider implements.
@Injectable()
export class ClaudeService implements OnModuleInit {
  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly logger: PinoLogger,
    private readonly config: ConfigService,
    private readonly promptStore: PromptStoreService,
    private readonly conversationStore: ConversationStoreService,
    private readonly modelRouter: ModelRouterService,
    private readonly registry: ProviderRegistryService,
  ) {
    this.logger.setContext('ClaudeService');
  }

  // Fail fast at bootstrap instead of failing on the first request. Either
  // backend is enough to run; both are optional as long as one is present.
  onModuleInit(): void {
    if (
      !this.config.get<string>('ANTHROPIC_API_KEY') &&
      !this.config.get<string>('OPENAI_API_KEY')
    ) {
      throw new Error(
        'Either ANTHROPIC_API_KEY or OPENAI_API_KEY environment variable must be set',
      );
    }
  }

  async sendMessage(request: SendMessageRequestDto): Promise<ClaudeResponse> {
    return this.createMessage({
      ...this.params(request),
      messages: [{ role: 'user', content: request.message }],
    });
  }

  async createConversation(
    request: ConversationRequestDto,
  ): Promise<ClaudeResponse> {
    return this.createMessage({
      ...this.params(request),
      messages: request.messages,
    });
  }

  // Streams the answer as normalized events: aggregated shapes reach the
  // consumer — message_start, text_delta, tool_use_*, thinking_*, and the
  // final message_stop with stopReason + usage. See streamRawMessage for the
  // unfiltered protocol (Anthropic models only).
  async *streamMessage(
    request: StreamRequestDto,
  ): AsyncGenerator<ClaudeStreamEvent> {
    yield* this.normalizedEvents(request);
  }

  async *streamRawMessage(
    request: StreamRequestDto,
  ): AsyncGenerator<ClaudeRawStreamEvent> {
    this.validateMessageXor(request);
    const route = this.resolveRoute(this.params(request).model);
    if (!route.provider.capabilities.rawProtocol) {
      throw new BadRequestException(
        [
          '/claude/raw-stream forwards the native Anthropic protocol;',
          `model "${request.model}" is served by the ${route.provider.name} provider`,
        ].join(' '),
      );
    }
    const stream = await route.provider.openRawStream!({
      ...this.params(request),
      model: route.model,
      messages: this.buildMessages(request),
    });

    try {
      // yield* delegates iteration unchanged — a pure pass-through.
      yield* stream;
    } finally {
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
    const params = this.params(request);
    const route = this.resolveRoute(params.model);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      this.logger.debug({ round }, 'tool orchestration round starting');
      let stopReason: string | null = null;
      // Text blocks of the assistant turn being streamed, replayed into
      // history when the model asks for tools next round.
      const assistantBlocks: ContentBlockParam[] = [];
      const pendingToolCalls: ToolUseBlockParam[] = [];

      // Each round replays the locally accumulated history (assistant tool
      // calls + tool results from previous rounds).
      for await (const event of route.provider.streamMessage({
        ...params,
        model: route.model,
        messages,
        tools,
      })) {
        switch (event.type) {
          case 'message_start':
            yield event;
            break;

          case 'text_delta': {
            const last = assistantBlocks.at(-1);
            if (last?.type !== 'text') {
              assistantBlocks.push({ type: 'text', text: '' });
            }
            (
              assistantBlocks.at(-1) as Extract<
                ContentBlockParam,
                { type: 'text' }
              >
            ).text += event.text;
            yield event;
            break;
          }

          case 'tool_use_start':
            pendingToolCalls.push({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: {},
            });
            yield event;
            break;

          case 'tool_use_delta':
            yield event;
            break;

          case 'tool_use_stop': {
            const call = pendingToolCalls.find(
              (candidate) => candidate.id === event.id,
            );
            if (call) {
              call.input = event.input;
            }
            yield event;
            break;
          }

          case 'thinking_delta':
          case 'thinking_stop':
            yield event;
            break;

          case 'message_stop':
            stopReason = event.stopReason;
            totalInputTokens += event.usage.inputTokens;
            totalOutputTokens += event.usage.outputTokens;
            break;
        }
      }

      if (stopReason !== 'tool_use' || pendingToolCalls.length === 0) {
        // Persist the exchange so the next request with this sessionId
        // continues the conversation.
        if (sessionId !== undefined && request.message !== undefined) {
          const finalText = assistantBlocks
            .filter(
              (block): block is Extract<ContentBlockParam, { type: 'text' }> =>
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

  async listModels(): Promise<ClaudeModel[]> {
    return this.registry.listModels();
  }

  private createMessage(params: ProviderRequest): Promise<ClaudeResponse> {
    const route = this.resolveRoute(params.model);
    return route.provider.createMessage({ ...params, model: route.model });
  }

  // Shared prologue for normalized streaming: enforce the XOR rule and feed
  // the built request through the routed provider.
  private async *normalizedEvents(
    request: StreamRequestDto,
    tools?: Tool[],
  ): AsyncGenerator<ProviderStreamEvent> {
    this.validateMessageXor(request);
    const route = this.resolveRoute(this.params(request).model);
    yield* route.provider.streamMessage({
      ...this.params(request),
      model: route.model,
      messages: this.buildMessages(request),
      ...(tools ? { tools } : {}),
    });
  }

  // Resolves routing up front so both callers can log/validate consistently.
  private resolveRoute(model: string) {
    return this.registry.resolve(model);
  }

  private validateMessageXor(request: StreamRequestDto): void {
    if (request.message !== undefined && request.messages !== undefined) {
      throw new BadRequestException(
        'Provide either "message" or "messages", not both',
      );
    }
  }

  private buildMessages(request: StreamRequestDto): ClaudeApiMessage[] {
    return (
      request.messages ?? [{ role: 'user', content: request.message ?? '' }]
    );
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

  // Builds the provider-level parameters: explicit model override wins over
  // router heuristics (see ModelRouterService).
  private params(
    request:
      | ConversationRequestDto
      | SendMessageRequestDto
      | StreamRequestDto
      | ChatRequestDto,
  ): Omit<ProviderRequest, 'messages'> {
    const system = this.resolveSystem(request);
    return {
      model: this.modelRouter.selectModel(
        request.model,
        this.inputTextOf(request),
      ),
      maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
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
}
