import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { ClaudeService } from './claude.service';

const mockCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockList = jest.fn<() => Promise<unknown>>();

jest.mock('@anthropic-ai/sdk', () => {
  const actual =
    jest.requireActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');

  class MockAnthropic {
    messages = { create: mockCreate };
    models = { list: mockList };
  }

  // Keep the real error classes so `instanceof` checks inside the service work.
  return { __esModule: true, ...actual, default: MockAnthropic };
});

const SDK_RESPONSE = {
  id: 'msg_1',
  model: 'claude-haiku-4-5',
  role: 'assistant',
  content: [
    { type: 'text', text: 'Hello ' },
    { type: 'text', text: 'world' },
  ],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
};

const EXPECTED_RESPONSE = {
  id: 'msg_1',
  model: 'claude-haiku-4-5',
  role: 'assistant',
  text: 'Hello world',
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
};

function sdkHeaders(): Headers {
  return new Headers({ 'request-id': 'test' });
}

describe('ClaudeService', () => {
  let service: ClaudeService;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockCreate.mockReset();
    mockList.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [ClaudeService],
    }).compile();

    service = moduleRef.get(ClaudeService);
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  describe('onModuleInit', () => {
    it('passes when the API key is set', () => {
      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('fails startup when the API key is missing', () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(() => service.onModuleInit()).toThrow(/ANTHROPIC_API_KEY/);
    });
  });

  describe('sendMessage', () => {
    it('applies defaults and normalizes the response', async () => {
      mockCreate.mockResolvedValue(SDK_RESPONSE);

      await expect(service.sendMessage({ message: 'Hi' })).resolves.toEqual(
        EXPECTED_RESPONSE,
      );

      expect(mockCreate).toHaveBeenCalledWith({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'Hi' }],
      });
    });

    it('omits system and temperature unless provided', async () => {
      mockCreate.mockResolvedValue(SDK_RESPONSE);

      await service.sendMessage({ message: 'Hi' });

      const [firstCallArgs] = mockCreate.mock.calls as unknown[][];
      expect(firstCallArgs).not.toHaveProperty('system');
      expect(firstCallArgs).not.toHaveProperty('temperature');
    });

    it('forwards optional overrides in SDK naming', async () => {
      mockCreate.mockResolvedValue(SDK_RESPONSE);

      await service.sendMessage({
        message: 'Hi',
        model: 'claude-sonnet-4-5',
        maxTokens: 250,
        system: 'Be brief.',
        temperature: 0.2,
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-sonnet-4-5',
          max_tokens: 250,
          system: 'Be brief.',
          temperature: 0.2,
        }),
      );
    });
  });

  describe('createConversation', () => {
    it('passes the history through unchanged', async () => {
      mockCreate.mockResolvedValue(SDK_RESPONSE);

      const messages = [
        { role: 'user' as const, content: 'What is DI?' },
        { role: 'assistant' as const, content: 'A way to pass dependencies.' },
        { role: 'user' as const, content: 'Show an example.' },
      ];

      await service.createConversation({ messages });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ messages }),
      );
    });
  });

  describe('listModels', () => {
    it('maps the SDK payload to the public shape', async () => {
      mockList.mockResolvedValue({
        data: [
          {
            id: 'claude-haiku-4-5',
            display_name: 'Claude Haiku 4.5',
            created_at: '2025-01-01T00:00:00Z',
          },
        ],
      });

      await expect(service.listModels()).resolves.toEqual([
        {
          id: 'claude-haiku-4-5',
          displayName: 'Claude Haiku 4.5',
          createdAt: '2025-01-01T00:00:00Z',
        },
      ]);
    });
  });

  describe('SDK error mapping', () => {
    it.each([
      [
        'authentication failure to 503',
        new AuthenticationError(401, {}, 'invalid x-api-key', sdkHeaders()),
        ServiceUnavailableException,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        'permission failure to 503',
        new PermissionDeniedError(403, {}, 'forbidden', sdkHeaders()),
        ServiceUnavailableException,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        'rate limit to 429',
        new RateLimitError(429, {}, 'rate limited', sdkHeaders()),
        HttpException,
        HttpStatus.TOO_MANY_REQUESTS,
      ],
      [
        'unknown model to 400',
        new NotFoundError(404, {}, 'model not found', sdkHeaders()),
        BadRequestException,
        HttpStatus.BAD_REQUEST,
      ],
      [
        'bad request to 400',
        new BadRequestError(400, {}, 'max_tokens too large', sdkHeaders()),
        BadRequestException,
        HttpStatus.BAD_REQUEST,
      ],
      [
        'connection failure to 503',
        new APIConnectionError({ message: 'connection refused' }),
        ServiceUnavailableException,
        HttpStatus.SERVICE_UNAVAILABLE,
      ],
      [
        'other API errors to 502',
        new APIError(500, {}, 'internal error', undefined),
        HttpException,
        HttpStatus.BAD_GATEWAY,
      ],
    ])(
      'maps %s',
      async (_name, sdkError, expectedException, expectedStatus) => {
        mockCreate.mockRejectedValue(sdkError);

        const rejection = service.sendMessage({ message: 'Hi' });
        await expect(rejection).rejects.toBeInstanceOf(expectedException);
        await rejection.catch((error) => {
          expect((error as HttpException).getStatus()).toBe(expectedStatus);
        });
      },
    );

    it('rethrows errors that are not SDK errors', async () => {
      const unexpected = new Error('boom');
      mockCreate.mockRejectedValue(unexpected);

      await expect(service.sendMessage({ message: 'Hi' })).rejects.toBe(
        unexpected,
      );
    });
  });
});
