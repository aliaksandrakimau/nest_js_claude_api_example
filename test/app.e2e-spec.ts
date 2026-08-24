import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const mockCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockList = jest.fn<() => Promise<unknown>>();

// Shape expected by the service from messages.create({stream: true}).
function fakeSdkStream(events: unknown[]) {
  let index = 0;
  return {
    controller: { abort: () => undefined },
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<unknown>> =>
          index < events.length
            ? Promise.resolve({ done: false, value: events[index++] })
            : Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
}

function parseSseFrames(text: string): unknown[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.length > 0)
    .map((frame): unknown => JSON.parse(frame.replace(/^data: /, '')));
}

jest.mock('@anthropic-ai/sdk', () => {
  const actual =
    jest.requireActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');

  class MockAnthropic {
    messages = { create: mockCreate };
    models = { list: mockList };
  }

  return { __esModule: true, ...actual, default: MockAnthropic };
});

describe('Claude endpoints (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(() => {
    mockCreate.mockReset();
    mockList.mockReset();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /claude/message returns the normalized answer', () => {
    mockCreate.mockResolvedValue({
      id: 'msg_1',
      model: 'claude-haiku-4-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    return request(app.getHttpServer())
      .post('/claude/message')
      .send({ message: 'Hi' })
      .expect(201)
      .expect((res) => {
        expect(res.body).toMatchObject({
          text: 'Hello world',
          model: 'claude-haiku-4-5',
          usage: { inputTokens: 10, outputTokens: 5 },
        });
      });
  });

  it('POST /claude/message rejects an empty message with 400', () => {
    return request(app.getHttpServer())
      .post('/claude/message')
      .send({ message: '   ' })
      .expect(400);
  });

  it('POST /claude/message rejects unknown properties with 400', () => {
    return request(app.getHttpServer())
      .post('/claude/message')
      .send({ message: 'Hi', bogus: true })
      .expect(400);
  });

  it('POST /claude/conversation validates nested messages', () => {
    return request(app.getHttpServer())
      .post('/claude/conversation')
      .send({ messages: [{ role: 'system', content: 'nope' }] })
      .expect(400)
      .expect((res) => {
        const body = res.body as { message?: unknown };
        expect(JSON.stringify(body.message)).toContain('role');
      });
  });

  it('POST /claude/stream emits the answer as SSE frames', () => {
    mockCreate.mockResolvedValue(
      fakeSdkStream([
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 10 },
          },
        },
        {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hel' },
        },
        {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'lo' },
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ]),
    );

    return request(app.getHttpServer())
      .post('/claude/stream')
      .send({ message: 'Hi' })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/)
      .expect((res) => {
        expect(parseSseFrames(res.text)).toEqual([
          { type: 'message_start', id: 'msg_1', model: 'claude-haiku-4-5' },
          { type: 'text_delta', text: 'Hel' },
          { type: 'text_delta', text: 'lo' },
          {
            type: 'message_stop',
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 2 },
          },
        ]);
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({ stream: true, max_tokens: 1000 }),
        );
      });
  });

  it('POST /claude/stream rejects message combined with messages', () => {
    return request(app.getHttpServer())
      .post('/claude/stream')
      .send({
        message: 'Hi',
        messages: [{ role: 'user', content: 'Hi again' }],
      })
      .expect(400);
  });

  it('POST /claude/stream rejects a body without message or messages', () => {
    return request(app.getHttpServer())
      .post('/claude/stream')
      .send({ model: 'claude-haiku-4-5' })
      .expect(400);
  });

  it('GET /claude/models returns mapped models', () => {
    mockList.mockResolvedValue({
      data: [
        {
          id: 'm1',
          display_name: 'Model One',
          created_at: '2025-01-01T00:00:00Z',
        },
      ],
    });

    return request(app.getHttpServer())
      .get('/claude/models')
      .expect(200)
      .expect((res) => {
        expect(res.body).toEqual([
          {
            id: 'm1',
            displayName: 'Model One',
            createdAt: '2025-01-01T00:00:00Z',
          },
        ]);
      });
  });
});
