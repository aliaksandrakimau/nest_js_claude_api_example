import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';

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
// text_delta frames to assemble the full answer.
export type ClaudeStreamEvent =
  | { type: 'message_start'; id: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'message_stop'; stopReason: string | null; usage: ClaudeUsage }
  | { type: 'error'; message: string };

export interface ClaudeModel {
  id: string;
  displayName: string;
  createdAt: string;
}

export type ClaudeApiMessage = MessageParam;
