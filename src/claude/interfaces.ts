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

export interface ClaudeModel {
  id: string;
  displayName: string;
  createdAt: string;
}

export type ClaudeApiMessage = MessageParam;
