import type { Model, StreamEvent } from './store.js';

export async function fetchModels(baseUrl: string): Promise<Model[]> {
  const res = await fetch(`${baseUrl}/claude/models`);
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  return res.json();
}

export async function createSession(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/claude/sessions`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
  const data = await res.json();
  return data.sessionId;
}

export async function getSessionHistory(
  baseUrl: string,
  sessionId: string,
): Promise<{ sessionId: string; messages: { role: string; content: string }[] }> {
  const res = await fetch(`${baseUrl}/claude/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`Session not found or expired`);
  return res.json();
}

export interface ChatParams {
  baseUrl: string;
  message: string;
  model: string;
  sessionId?: string | null;
  temperature?: number;
  maxTokens?: number;
  system?: string | null;
}

export async function* chatStream(params: ChatParams): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    message: params.message,
    model: params.model,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
  };
  if (params.sessionId) body.sessionId = params.sessionId;
  if (params.system) body.system = params.system;

  const res = await fetch(`${params.baseUrl}/claude/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || `HTTP ${res.status}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const json = trimmed.slice(6);
      if (!json || json === '[DONE]') continue;
      try {
        yield JSON.parse(json) as StreamEvent;
      } catch {
        // skip malformed frames
      }
    }
  }
}

export async function sendMessage(params: ChatParams): Promise<{ text: string; model: string; usage: unknown }> {
  const body: Record<string, unknown> = {
    message: params.message,
    model: params.model,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
  };
  if (params.sessionId) body.sessionId = params.sessionId;
  if (params.system) body.system = params.system;

  const res = await fetch(`${params.baseUrl}/claude/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(error.message || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function listPrompts(baseUrl: string): Promise<{ name: string; version: number; text: string }[]> {
  const res = await fetch(`${baseUrl}/claude/prompts`);
  if (!res.ok) throw new Error(`Failed to fetch prompts: ${res.status}`);
  return res.json();
}
