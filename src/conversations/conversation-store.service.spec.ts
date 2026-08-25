import { BadRequestException } from '@nestjs/common';
import { ConversationStoreService } from './conversation-store.service';

describe('ConversationStoreService', () => {
  let store: ConversationStoreService;

  beforeEach(() => {
    jest.useFakeTimers();
    store = new ConversationStoreService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates sessions with unique ids and empty history', () => {
    const first = store.createSession();
    const second = store.createSession();

    expect(first).not.toBe(second);
    expect(store.getHistory(first)).toEqual([]);
  });

  it('stores user/assistant turns in order', () => {
    const id = store.createSession();
    store.appendTurn(id, 'Hi', 'Hello!');
    store.appendTurn(id, 'How are you?', 'Fine.');

    expect(store.getHistory(id)).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: 'Fine.' },
    ]);
  });

  it('expires sessions after the TTL of inactivity', () => {
    const id = store.createSession();

    // One millisecond past the 30-minute TTL.
    jest.advanceTimersByTime(30 * 60 * 1000 + 1);

    expect(() => store.getHistory(id)).toThrow(BadRequestException);
  });

  it('refreshes the TTL on every appended turn', () => {
    const id = store.createSession();
    store.appendTurn(id, 'Hi', 'Hello!');

    jest.advanceTimersByTime(20 * 60 * 1000);
    store.appendTurn(id, 'Still there?', 'Yes.');
    jest.advanceTimersByTime(20 * 60 * 1000);

    // 40 minutes since creation but only 20 since the last turn.
    expect(store.getHistory(id)).toHaveLength(4);
  });

  it('trims history beyond the per-session cap', () => {
    const id = store.createSession();
    for (let i = 0; i < 60; i++) {
      store.appendTurn(id, `u${i}`, `a${i}`);
    }

    const history = store.getHistory(id);
    expect(history).toHaveLength(100);
    expect(history[0]).toEqual({ role: 'user', content: 'u10' });
    expect(history.at(-1)).toEqual({ role: 'assistant', content: 'a59' });
  });
});
