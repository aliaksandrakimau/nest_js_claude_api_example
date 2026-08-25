export interface Model {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
}

export interface StreamEvent {
  type: string;
  id?: string;
  model?: string;
  text?: string;
  name?: string;
  input?: unknown;
  partialJson?: string;
  stopReason?: string | null;
  usage?: { inputTokens: number; outputTokens: number };
  message?: string;
}

export interface CliState {
  baseUrl: string;
  model: string;
  sessionId: string | null;
  temperature: number;
  maxTokens: number;
  systemPrompt: string | null;
  streamingEnabled: boolean;
  messages: Message[];
  streamingText: string;
  isStreaming: boolean;
  models: Model[];
  modelsLoaded: boolean;
}

export const initialState: CliState = {
  baseUrl: 'http://localhost:3000',
  model: 'ox-alpha-free',
  sessionId: null,
  temperature: 0.7,
  maxTokens: 1000,
  systemPrompt: null,
  streamingEnabled: true,
  messages: [],
  streamingText: '',
  isStreaming: false,
  models: [],
  modelsLoaded: false,
};
