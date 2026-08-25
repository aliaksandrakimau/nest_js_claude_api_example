import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ClaudeModel, ClaudeResponse } from '../interfaces';
import type {
  ModelProvider,
  ProviderRequest,
  ProviderStreamEvent,
} from './provider.interface';

// OpenAI wire-format messages. Tool interactions are represented as separate
// messages (assistant `tool_calls`, then one `tool` message per result), while
// the internal Anthropic-style format packs them into content blocks — the
// translation happens in toOpenAiMessages.
interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// Loose typing on purpose: any OpenAI-compatible endpoint may omit optional
// fields, so everything read off the response is defensive.
interface OpenAiCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAiStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Provider for any OpenAI-compatible chat completions endpoint (OpenAI,
 * OpenRouter, vLLM, Ollama's compat layer...). Uses plain fetch instead of an
 * SDK so arbitrary base URLs keep working without extra dependencies.
 */
@Injectable()
export class OpenAiProvider implements ModelProvider {
  readonly name = 'openai';
  readonly capabilities = { rawProtocol: false };

  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('OpenAiProvider');
  }

  // Whether a third-party endpoint is available at all; drives both model
  // routing and whether unqualified ids may be sent there.
  isConfigured(): boolean {
    return Boolean(this.config.get<string>('OPENAI_API_KEY'));
  }

  async createMessage(request: ProviderRequest): Promise<ClaudeResponse> {
    const data = (await this.postJson(
      '/chat/completions',
      this.requestBody(request, false),
    )) as OpenAiCompletionResponse;

    const choice = data.choices?.[0];
    if (!choice) {
      throw new HttpException(
        'The OpenAI-compatible endpoint returned no choices',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return {
      id: data.id ?? '',
      model: data.model ?? request.model,
      role: 'assistant',
      text: choice.message?.content ?? '',
      stopReason: mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }

  // Translates the OpenAI chunk protocol into normalized provider events.
  // Tool calls arrive as incremental argument fragments across chunks; they
  // are buffered per call and parsed once when the stream ends.
  async *streamMessage(
    request: ProviderRequest,
  ): AsyncGenerator<ProviderStreamEvent> {
    const controller = new AbortController();
    try {
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl()}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(this.requestBody(request, true)),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          // Consumer disconnected before the stream opened.
          return;
        }
        throw new ServiceUnavailableException(
          'Could not reach the OpenAI-compatible endpoint',
        );
      }
      await this.unwrap(response);

      if (!response.body) {
        throw new HttpException(
          'The OpenAI-compatible endpoint returned an empty body',
          HttpStatus.BAD_GATEWAY,
        );
      }

      yield* this.parseChunkStream(response.body, request.model);
    } finally {
      // Cancel the upstream request when the consumer leaves early.
      controller.abort();
    }
  }

  // Ids are returned with the routing prefix already applied so clients can
  // pass them back as `model` verbatim.
  async listModels(): Promise<ClaudeModel[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/models`, {
        headers: this.headers(),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Could not reach the OpenAI-compatible endpoint',
      );
    }
    await this.unwrap(response);

    const data = (await response.json()) as {
      data?: Array<{ id?: string; created?: number }>;
    };
    return (data.data ?? [])
      .filter((model) => typeof model.id === 'string')
      .map((model) => ({
        id: `openai/${model.id}`,
        displayName: model.id!,
        createdAt:
          typeof model.created === 'number'
            ? new Date(model.created * 1000).toISOString()
            : '',
      }));
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('OPENAI_BASE_URL') ?? DEFAULT_BASE_URL
    ).replace(/\/$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.get<string>('OPENAI_API_KEY')}`,
    };
  }

  private requestBody(request: ProviderRequest, stream: boolean): unknown {
    const messages: OpenAiChatMessage[] = [];
    // OpenAI has no dedicated system parameter — it becomes a leading message.
    if (request.system !== undefined) {
      messages.push({ role: 'system', content: request.system });
    }
    messages.push(...this.toOpenAiMessages(request.messages));

    return {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map(toOpenAiTool),
            tool_choice: 'auto',
          }
        : {}),
      ...(stream
        ? // Ask for token usage in streaming mode; endpoints that do not
          // support the option ignore it and usage degrades to zeros.
          { stream: true, stream_options: { include_usage: true } }
        : {}),
    };
  }

  // Translates internal Anthropic-style history into OpenAI messages. Text
  // blocks accumulate; tool_use/tool_result blocks force separate messages
  // because that is how the OpenAI format represents them.
  private toOpenAiMessages(
    messages: ProviderRequest['messages'],
  ): OpenAiChatMessage[] {
    const result: OpenAiChatMessage[] = [];

    for (const message of messages) {
      if (typeof message.content === 'string') {
        result.push({ role: message.role, content: message.content });
        continue;
      }

      if (message.role === 'assistant') {
        let text = '';
        const toolCalls: OpenAiToolCall[] = [];
        for (const block of message.content) {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
        }
        if (text || toolCalls.length > 0) {
          result.push({
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
        continue;
      }

      // User turn: text accumulates into user messages, each tool_result
      // becomes its own tool message referencing the originating call.
      let text = '';
      const flushText = () => {
        if (text) {
          result.push({ role: 'user', content: text });
          text = '';
        }
      };
      for (const block of message.content) {
        if (block.type === 'text') {
          text += block.text;
        } else if (block.type === 'tool_result') {
          flushText();
          result.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultContent(block.content),
          });
        }
      }
      flushText();
    }

    return result;
  }

  private async *parseChunkStream(
    body: ReadableStream<Uint8Array>,
    fallbackModel: string,
  ): AsyncGenerator<ProviderStreamEvent> {
    const decoder = new TextDecoder();
    let buffer = '';
    let started = false;
    let finishReason: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0 };
    // Buffered tool calls by their stream index; arguments are assembled from
    // fragments across chunks and parsed at stream end.
    const tools = new Map<number, { id: string; name: string; json: string }>();

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.startsWith('data:')) {
          continue;
        }
        const payload = line.slice('data:'.length).trim();
        if (payload === '[DONE]') {
          continue;
        }
        let parsed: OpenAiStreamChunk;
        try {
          parsed = JSON.parse(payload) as OpenAiStreamChunk;
        } catch {
          continue;
        }

        if (!started) {
          started = true;
          yield {
            type: 'message_start',
            id: parsed.id ?? '',
            model: parsed.model ?? fallbackModel,
          };
        }

        if (parsed.usage) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens ?? 0,
            outputTokens: parsed.usage.completion_tokens ?? 0,
          };
        }

        const choice = parsed.choices?.[0];
        if (!choice) {
          continue;
        }

        if (choice.delta?.content) {
          yield { type: 'text_delta', text: choice.delta.content };
        }

        for (const call of choice.delta?.tool_calls ?? []) {
          // Servers that omit the index emit exactly one sequential call.
          const index =
            typeof call.index === 'number'
              ? call.index
              : Math.max(tools.size - 1, 0);
          let entry = tools.get(index);
          if (!entry) {
            entry = {
              id: call.id ?? `call_${index}`,
              name: call.function?.name ?? '',
              json: '',
            };
            tools.set(index, entry);
            yield { type: 'tool_use_start', id: entry.id, name: entry.name };
          }
          if (call.function?.arguments) {
            entry.json += call.function.arguments;
            yield {
              type: 'tool_use_delta',
              partialJson: call.function.arguments,
            };
          }
        }

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    }

    for (const entry of tools.values()) {
      let input: unknown;
      try {
        input = entry.json ? JSON.parse(entry.json) : {};
      } catch {
        input = entry.json;
      }
      yield { type: 'tool_use_stop', id: entry.id, name: entry.name, input };
    }

    yield {
      type: 'message_stop',
      stopReason: mapStopReason(finishReason),
      usage,
    };
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Could not reach the OpenAI-compatible endpoint',
      );
    }
    await this.unwrap(response);
    return response.json();
  }

  // Translate HTTP failures into meaningful responses with the same semantics
  // as the Anthropic provider: broken key or endpoint is ours (503), caller
  // mistakes like an unknown model are theirs (400), anything else is 502.
  private async unwrap(response: Response): Promise<void> {
    if (response.ok) {
      return;
    }
    const detail = await response.text().catch(() => '');
    const message = extractErrorMessage(detail) ?? response.statusText;

    if (response.status === 401 || response.status === 403) {
      this.logger.error(
        { status: response.status },
        'OpenAI-compatible endpoint rejected the configured key',
      );
      throw new ServiceUnavailableException(
        'OpenAI-compatible endpoint rejected OPENAI_API_KEY',
      );
    }
    if (response.status === 429) {
      throw new HttpException(
        'OpenAI-compatible endpoint rate limit exceeded, retry later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if ([400, 404, HttpStatus.UNPROCESSABLE_ENTITY].includes(response.status)) {
      throw new BadRequestException(message);
    }
    throw new HttpException(message, HttpStatus.BAD_GATEWAY);
  }
}

function toOpenAiTool(tool: Tool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

function toolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    // Block arrays degrade to their concatenated text.
    return content
      .map((block) =>
        block && typeof block === 'object' && 'text' in block
          ? String((block as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  return JSON.stringify(content ?? '');
}

// Maps OpenAI finish reasons onto the stop-reason vocabulary the API surface
// already speaks; unknown reasons pass through unchanged.
function mapStopReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case null:
    case undefined:
      return null;
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return reason;
  }
}

function extractErrorMessage(body: string): string | null {
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === 'object' && parsed.error.message) {
      return parsed.error.message;
    }
    if (typeof parsed.error === 'string') {
      return parsed.error;
    }
    return parsed.message ?? null;
  } catch {
    return body.length > 500 ? body.slice(0, 500) : body;
  }
}
