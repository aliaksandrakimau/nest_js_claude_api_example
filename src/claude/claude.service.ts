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
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ConversationRequestDto,
  SendMessageRequestDto,
  StreamRequestDto,
} from './dto';
import type {
  ClaudeApiMessage,
  ClaudeModel,
  ClaudeRawStreamEvent,
  ClaudeResponse,
  ClaudeStreamEvent,
  UpstreamStream,
} from './interfaces';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 1000;

@Injectable()
export class ClaudeService implements OnModuleInit {
  private client?: Anthropic;

  // Fail fast at bootstrap instead of failing on the first request.
  onModuleInit(): void {
    if (!process.env.ANTHROPIC_API_KEY) {
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

      return {
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
    } catch (error) {
      this.mapSdkError(error);
    }
  }

  private options(
    request: ConversationRequestDto | SendMessageRequestDto | StreamRequestDto,
  ): {
    model: string;
    max_tokens: number;
    system?: string;
    temperature?: number;
  } {
    return {
      model: request.model ?? DEFAULT_MODEL,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.system ? { system: request.system } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    };
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
      throw new ServiceUnavailableException(
        'Anthropic API rejected ANTHROPIC_API_KEY',
      );
    }

    if (error instanceof RateLimitError) {
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
