import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages';

export type ClaudeRole = 'user' | 'assistant';

export interface ClaudeMessage {
  role: ClaudeRole;
  content: string;
}

export interface ClaudeRequestOptions {
  model?: string;
  maxTokens?: number;
  system?: string;
  temperature?: number;
}

export interface SendMessageRequest extends ClaudeRequestOptions {
  message: string;
}

export interface ConversationRequest extends ClaudeRequestOptions {
  messages: ClaudeMessage[];
}

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
