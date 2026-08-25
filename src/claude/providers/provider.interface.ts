import type {
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  ClaudeModel,
  ClaudeRawStreamEvent,
  ClaudeResponse,
  ClaudeUsage,
  UpstreamStream,
} from '../interfaces';

// Canonical internal request format. History and tool definitions keep the
// Anthropic shapes because that is what the rest of the app already speaks
// (DTOs, the session store, the tool registry); each provider translates them
// into its own wire format. `model` is a bare id — any provider prefix has
// been stripped by the registry before the request gets here.
export interface ProviderRequest {
  model: string;
  messages: MessageParam[];
  system?: string;
  maxTokens: number;
  temperature?: number;
  tools?: Tool[];
}

// Normalized streaming contract shared by every provider. Third-party
// protocols (OpenAI chunk format, etc.) are translated into these shapes, so
// consumers of /claude/stream and /claude/chat never see provider differences.
export type ProviderStreamEvent =
  | { type: 'message_start'; id: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partialJson: string }
  | { type: 'tool_use_stop'; id: string; name: string; input: unknown }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'thinking_stop'; signature: string }
  | { type: 'message_stop'; stopReason: string | null; usage: ClaudeUsage };

export interface ModelProvider {
  readonly name: string;
  // rawProtocol marks providers whose native wire protocol can be passed
  // through unmodified (the /claude/raw-stream endpoint). Only makes sense
  // for the native Anthropic provider.
  readonly capabilities: { rawProtocol: boolean };
  createMessage(request: ProviderRequest): Promise<ClaudeResponse>;
  streamMessage(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent>;
  listModels(): Promise<ClaudeModel[]>;
  // Only available when capabilities.rawProtocol is true: opens a stream of
  // unmodified wire events; the caller iterates verbatim and aborts via
  // `stream.controller`.
  openRawStream?(
    request: ProviderRequest,
  ): Promise<UpstreamStream & AsyncIterable<ClaudeRawStreamEvent>>;
}

// The result of routing a model id to a provider: the provider to execute on
// plus the bare model id to send upstream.
export interface ResolvedRoute {
  provider: ModelProvider;
  model: string;
}
