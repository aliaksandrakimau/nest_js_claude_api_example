import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { ConversationRequestDto, SendMessageRequestDto } from './dto';
import { ClaudeApiMessage, ClaudeModel, ClaudeResponse } from './interfaces';

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

  private options(request: ConversationRequestDto | SendMessageRequestDto): {
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
