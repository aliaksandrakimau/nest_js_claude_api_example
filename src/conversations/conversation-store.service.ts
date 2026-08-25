import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Session {
  messages: ConversationMessage[];
  expiresAt: number;
}

// Sessions live 30 minutes of inactivity; each turn refreshes the clock.
const SESSION_TTL_MS = 30 * 60 * 1000;
// Hard cap so one runaway session cannot grow without bound.
const MAX_MESSAGES_PER_SESSION = 100;

/**
 * In-memory conversation store. Sessions hold the full user/assistant
 * history so clients can send only the new message instead of replaying the
 * whole dialog. Swap the Map for Redis/SQLite to survive restarts or share
 * state across replicas.
 */
@Injectable()
export class ConversationStoreService {
  private readonly sessions = new Map<string, Session>();

  /** Creates an empty session and returns its id. */
  createSession(): string {
    const id = randomUUID();
    this.sessions.set(id, {
      messages: [],
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return id;
  }

  /** Returns a copy of the session history or throws for unknown/expired ids. */
  getHistory(sessionId: string): ConversationMessage[] {
    return [...this.liveSession(sessionId).messages];
  }

  /** Appends one user/assistant turn and refreshes the session TTL. */
  appendTurn(
    sessionId: string,
    userContent: string,
    assistantContent: string,
  ): void {
    const session = this.liveSession(sessionId);
    session.messages.push(
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    );
    if (session.messages.length > MAX_MESSAGES_PER_SESSION) {
      session.messages.splice(
        0,
        session.messages.length - MAX_MESSAGES_PER_SESSION,
      );
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
  }

  private liveSession(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      throw new BadRequestException('Unknown or expired sessionId');
    }
    return session;
  }
}
