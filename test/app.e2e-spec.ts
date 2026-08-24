import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const mockCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockList = jest.fn<() => Promise<unknown>>();

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
