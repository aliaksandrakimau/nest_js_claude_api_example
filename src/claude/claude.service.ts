import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import {
  ClaudeApiMessage,
  ClaudeModel,
  ClaudeRequestOptions,
  ClaudeResponse,
  ConversationRequest,
  SendMessageRequest,
} from './interfaces';

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 1000;

@Injectable()
export class ClaudeService {
  private client?: Anthropic;

  async sendMessage(request: SendMessageRequest): Promise<ClaudeResponse> {
    this.validateMessage(request.message);

    return this.createMessage({
      ...this.options(request),
      messages: [{ role: 'user', content: request.message }],
    });
  }

  async createConversation(
    request: ConversationRequest,
  ): Promise<ClaudeResponse> {
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new BadRequestException(
        'messages must contain at least one message',
      );
    }

    request.messages.forEach((message) =>
      this.validateMessage(message.content),
    );

    return this.createMessage({
      ...this.options(request),
      messages: request.messages,
    });
  }

  async listModels(): Promise<ClaudeModel[]> {
    this.ensureApiKey();
    const response = await this.getClient().models.list();

    return response.data.map((model) => ({
      id: model.id,
      displayName: model.display_name,
      createdAt: model.created_at,
    }));
  }

  private async createMessage(params: {
    messages: ClaudeApiMessage[];
    model: string;
    max_tokens: number;
    system?: string;
    temperature?: number;
  }): Promise<ClaudeResponse> {
    this.ensureApiKey();

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
  }

  private options(request: ClaudeRequestOptions) {
    return {
      model: request.model ?? DEFAULT_MODEL,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(request.system ? { system: request.system } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
    };
  }

  private validateMessage(message: string): void {
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new BadRequestException('message content must not be empty');
    }
  }

  private ensureApiKey(): void {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY is not configured',
      );
    }
  }

  private getClient(): Anthropic {
    return (this.client ??= new Anthropic());
  }
}
