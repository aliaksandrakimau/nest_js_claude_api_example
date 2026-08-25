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
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type {
  ClaudeModel,
  ClaudeResponse,
  UpstreamStream,
} from '../interfaces';
import type {
  ModelProvider,
  ProviderRequest,
  ProviderStreamEvent,
} from './provider.interface';

// Native provider: talks to the Anthropic Messages API through the official
// SDK. Also the keeper of the raw wire protocol used by /claude/raw-stream.
@Injectable()
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly capabilities = { rawProtocol: true };
  private client?: Anthropic;

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext('AnthropicProvider');
  }

  async createMessage(request: ProviderRequest): Promise<ClaudeResponse> {
    try {
      const response = await this.getClient().messages.create({
        ...this.sdkParams(request),
        messages: request.messages,
      });

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

  // Normalizes the raw protocol into ProviderStreamEvent shapes. See
  // streamRawMessage for the unfiltered pass-through.
  async *streamMessage(
    request: ProviderRequest,
  ): AsyncGenerator<ProviderStreamEvent> {
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

  // Opens a stream for the UNMODIFIED Anthropic protocol; the caller iterates
  // it verbatim and is responsible for aborting via `controller`.
  openRawStream(request: ProviderRequest): Promise<UpstreamStream> {
    return this.openStream(request);
  }

  private async openStream(request: ProviderRequest): Promise<UpstreamStream> {
    try {
      return await this.getClient().messages.create({
        ...this.sdkParams(request),
        messages: request.messages,
        stream: true,
      });
    } catch (error) {
      this.mapSdkError(error);
    }
  }

  private sdkParams(request: ProviderRequest): {
    model: string;
    max_tokens: number;
    system?: string;
    temperature?: number;
    tools?: Tool[];
  } {
    return {
      model: request.model,
      max_tokens: request.maxTokens,
      ...(request.system ? { system: request.system } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      // The tool definitions keep the native Anthropic shape everywhere
      // internally, so they pass through unchanged.
      ...(request.tools ? { tools: request.tools } : {}),
    };
  }

  getClient(): Anthropic {
    return (this.client ??= new Anthropic());
  }

  // Translate SDK failures into meaningful HTTP responses instead of leaking
  // raw 500s. Authentication problems are ours (the configured key), not the
  // caller's, so they surface as 503; caller mistakes like an unknown model
  // surface as 400; anything else from the API becomes 502.
  mapSdkError(error: unknown): never {
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
}
