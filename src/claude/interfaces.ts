import type {
  MessageParam,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages/messages';

export type ClaudeRole = 'user' | 'assistant';

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ClaudeResponse {
  id: string;
  model: string;
  role: ClaudeRole;
  text: string;
  stopReason: string | null;
  usage: ClaudeUsage;
}

// Events sent over the /claude/stream SSE endpoint. Each event is written as
// one `data: <json>` frame; the consumer concatenates the `text` of successive
// text_delta frames to assemble the full answer. Tool use and thinking events
// are included so the normalized stream can serve as a complete protocol view.
export type ClaudeStreamEvent =
  | { type: 'message_start'; id: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; partialJson: string }
  | { type: 'tool_use_stop'; id: string; name: string; input: unknown }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'thinking_stop'; signature: string }
  | { type: 'message_stop'; stopReason: string | null; usage: ClaudeUsage }
  | { type: 'error'; message: string };

// What the SDK returns for stream:true calls: an async iterable of raw
// protocol events plus an AbortController to cancel the upstream request.
export type UpstreamStream = AsyncIterable<RawMessageStreamEvent> & {
  controller: AbortController;
};

// The unmodified Anthropic streaming protocol event. Unlike the normalized
// ClaudeStreamEvent above, nothing is aggregated or dropped here — this is the
// wire-level view served by /claude/raw-stream.
export type ClaudeRawStreamEvent = RawMessageStreamEvent;

export interface ClaudeModel {
  id: string;
  displayName: string;
  createdAt: string;
}

export type ClaudeApiMessage = MessageParam;
