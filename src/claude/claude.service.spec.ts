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
import { ToolRegistryService } from './tools/tool-registry.service';
import { PinoLogger } from 'nestjs-pino';

const mockCreate = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockList = jest.fn<() => Promise<unknown>>();
const mockDispatch =
  jest.fn<(name: string, input: Record<string, unknown>) => Promise<string>>();

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

describe('ClaudeService', () => {
  let service: ClaudeService;
  const originalKey = process.env.ANTHROPIC_API_KEY;

  // Registry stub exposing one calculator-like tool by default.
  const toolRegistry = {
    hasTools: jest.fn(() => true),
    getToolDefinitions: jest.fn(() => [
      {
        name: 'calculator',
        description: 'math',
        input_schema: { type: 'object', properties: {} },
      },
    ]),
    dispatch: mockDispatch,
  };

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockCreate.mockReset();
    mockList.mockReset();
    mockDispatch.mockReset();
    jest.spyOn(toolRegistry, 'hasTools').mockImplementation(() => true);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClaudeService,
        { provide: ToolRegistryService, useValue: toolRegistry },
        // Silent logger stub: keeps test output clean and lets assertions
        // inspect log calls if ever needed.
        {
          provide: PinoLogger,
          useValue: Object.assign(jest.fn(), {
            setContext: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
          }),
        },
      ],
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

  describe('streamMessage', () => {
    const SDK_STREAM = [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10 },
        },
      },
      { type: 'content_block_start', content_block: { type: 'text' } },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hel' },
      },
      // Non-text deltas must be skipped silently.
      {
        type: 'content_block_delta',
        delta: { type: 'signature_delta', signature: 'sig' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'lo' },
      },
      { type: 'content_block_stop' },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ];

    it('normalizes raw SDK events and starts a streaming request', async () => {
      mockCreate.mockResolvedValue(fakeSdkStream(SDK_STREAM));

      const events = [];
      for await (const event of service.streamMessage({ message: 'Hi' })) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'message_start', id: 'msg_1', model: 'claude-haiku-4-5' },
        { type: 'text_delta', text: 'Hel' },
        { type: 'thinking_stop', signature: 'sig' },
        { type: 'text_delta', text: 'lo' },
        {
          type: 'message_stop',
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      ]);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'claude-haiku-4-5',
          max_tokens: 1000,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      );
    });

    it('passes the conversation history through', async () => {
      mockCreate.mockResolvedValue(fakeSdkStream(SDK_STREAM));

      const messages = [{ role: 'user' as const, content: 'Hello?' }];
      // Pull one event to trigger the upstream request.
      await service.streamMessage({ messages }).next();

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ messages, stream: true }),
      );
    });

    it('rejects message combined with messages', async () => {
      await expect(
        service
          .streamMessage({
            message: 'Hi',
            messages: [{ role: 'user', content: 'Hi again' }],
          })
          .next(),
      ).rejects.toThrow(BadRequestException);
    });

    it('aborts the upstream request when the consumer leaves early', async () => {
      const stream = fakeSdkStream(SDK_STREAM);
      const abortSpy = jest.spyOn(stream.controller, 'abort');
      mockCreate.mockResolvedValue(stream);

      for await (const event of service.streamMessage({ message: 'Hi' })) {
        expect(event.type).toBe('message_start');
        break;
      }

      expect(abortSpy).toHaveBeenCalled();
    });

    it('maps SDK failures raised before the first event', async () => {
      mockCreate.mockRejectedValue(
        new AuthenticationError(401, {}, 'invalid x-api-key', sdkHeaders()),
      );

      await expect(
        service.streamMessage({ message: 'Hi' }).next(),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('emits tool_use events when Claude requests a tool call', async () => {
      const TOOL_STREAM = [
        {
          type: 'message_start',
          message: {
            id: 'msg_2',
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 5 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'calculator',
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"expr' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: 'ession":"2+2"}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 15 },
        },
        { type: 'message_stop' },
      ];
      mockCreate.mockResolvedValue(fakeSdkStream(TOOL_STREAM));

      const events = [];
      for await (const event of service.streamMessage({ message: '2+2' })) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'message_start', id: 'msg_2', model: 'claude-haiku-4-5' },
        { type: 'tool_use_start', id: 'toolu_1', name: 'calculator' },
        { type: 'tool_use_delta', partialJson: '{"expr' },
        { type: 'tool_use_delta', partialJson: 'ession":"2+2"}' },
        {
          type: 'tool_use_stop',
          id: 'toolu_1',
          name: 'calculator',
          input: { expression: '2+2' },
        },
        {
          type: 'message_stop',
          stopReason: 'tool_use',
          usage: { inputTokens: 5, outputTokens: 15 },
        },
      ]);
    });

    it('emits thinking events during extended thinking', async () => {
      const THINKING_STREAM = [
        {
          type: 'message_start',
          message: {
            id: 'msg_3',
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 8 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Let me consider' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: ' this carefully' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig123' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'The answer is 4' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 20 },
        },
        { type: 'message_stop' },
      ];
      mockCreate.mockResolvedValue(fakeSdkStream(THINKING_STREAM));

      const events = [];
      for await (const event of service.streamMessage({ message: '2+2' })) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'message_start', id: 'msg_3', model: 'claude-haiku-4-5' },
        { type: 'thinking_delta', thinking: 'Let me consider' },
        { type: 'thinking_delta', thinking: ' this carefully' },
        { type: 'thinking_stop', signature: 'sig123' },
        { type: 'text_delta', text: 'The answer is 4' },
        {
          type: 'message_stop',
          stopReason: 'end_turn',
          usage: { inputTokens: 8, outputTokens: 20 },
        },
      ]);
    });

    it('handles multiple tool_use blocks in a single response', async () => {
      const MULTI_TOOL_STREAM = [
        {
          type: 'message_start',
          message: {
            id: 'msg_4',
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 5 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'calculator',
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"e":"1+1"}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'calculator',
          },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"e":"3+3"}' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 25 },
        },
        { type: 'message_stop' },
      ];
      mockCreate.mockResolvedValue(fakeSdkStream(MULTI_TOOL_STREAM));

      const events = [];
      for await (const event of service.streamMessage({ message: 'math' })) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'message_start', id: 'msg_4', model: 'claude-haiku-4-5' },
        { type: 'tool_use_start', id: 'toolu_1', name: 'calculator' },
        { type: 'tool_use_delta', partialJson: '{"e":"1+1"}' },
        {
          type: 'tool_use_stop',
          id: 'toolu_1',
          name: 'calculator',
          input: { e: '1+1' },
        },
        { type: 'tool_use_start', id: 'toolu_2', name: 'calculator' },
        { type: 'tool_use_delta', partialJson: '{"e":"3+3"}' },
        {
          type: 'tool_use_stop',
          id: 'toolu_2',
          name: 'calculator',
          input: { e: '3+3' },
        },
        {
          type: 'message_stop',
          stopReason: 'tool_use',
          usage: { inputTokens: 5, outputTokens: 25 },
        },
      ]);
    });
  });

  describe('streamRawMessage', () => {
    // A deliberately varied slice of the real protocol: block lifecycle,
    // a keepalive ping and non-text deltas must all survive untouched.
    const RAW_STREAM = [
      {
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 10 },
        },
      },
      { type: 'ping' },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      },
      // Normalization would drop this; raw pass-through keeps it.
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ];

    it('yields upstream events verbatim, without aggregating anything', async () => {
      mockCreate.mockResolvedValue(fakeSdkStream(RAW_STREAM));

      const events = [];
      for await (const event of service.streamRawMessage({ message: 'Hi' })) {
        events.push(event);
      }

      expect(events).toEqual(RAW_STREAM);
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Hi' }],
          stream: true,
        }),
      );
    });

    it('rejects message combined with messages', async () => {
      await expect(
        service
          .streamRawMessage({
            message: 'Hi',
            messages: [{ role: 'user', content: 'Hi again' }],
          })
          .next(),
      ).rejects.toThrow(BadRequestException);
    });

    it('aborts the upstream request when the consumer leaves early', async () => {
      const stream = fakeSdkStream(RAW_STREAM);
      const abortSpy = jest.spyOn(stream.controller, 'abort');
      mockCreate.mockResolvedValue(stream);

      for await (const event of service.streamRawMessage({ message: 'Hi' })) {
        expect(event.type).toBe('message_start');
        break;
      }

      expect(abortSpy).toHaveBeenCalled();
    });

    it('maps SDK failures raised before the first event', async () => {
      mockCreate.mockRejectedValue(
        new AuthenticationError(401, {}, 'invalid x-api-key', sdkHeaders()),
      );

      await expect(
        service.streamRawMessage({ message: 'Hi' }).next(),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('streamWithTools', () => {
    const ROUND_START = {
      type: 'message_start',
      message: {
        id: 'msg_r',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 10 },
      },
    };

    function toolRoundEvents(stopReason = 'tool_use') {
      return [
        ROUND_START,
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'calculator',
          },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'input_json_delta',
            partial_json: '{"expression":"2+2"}',
          },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: stopReason },
          usage: { output_tokens: 12 },
        },
        { type: 'message_stop' },
      ];
    }

    const FINAL_ROUND_EVENTS = [
      {
        type: 'message_start',
        message: {
          id: 'msg_final',
          model: 'claude-haiku-4-5',
          usage: { input_tokens: 25 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'The answer is 4' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 8 },
      },
      { type: 'message_stop' },
    ];

    it('runs one round when the model answers without calling tools', async () => {
      mockCreate.mockResolvedValueOnce(fakeSdkStream(FINAL_ROUND_EVENTS));

      const events = [];
      for await (const event of service.streamWithTools({ message: 'hi' })) {
        events.push(event);
      }

      expect(mockDispatch).not.toHaveBeenCalled();
      expect(events.at(-1)).toEqual({
        type: 'message_stop',
        stopReason: 'end_turn',
        usage: { inputTokens: 25, outputTokens: 8 },
      });
    });

    it('runs the tool and continues until the final answer', async () => {
      mockCreate
        .mockResolvedValueOnce(fakeSdkStream(toolRoundEvents()))
        .mockResolvedValueOnce(fakeSdkStream(FINAL_ROUND_EVENTS));
      mockDispatch.mockResolvedValue('4');

      const events = [];
      for await (const event of service.streamWithTools({ message: '2+2?' })) {
        events.push(event);
      }

      expect(mockDispatch).toHaveBeenCalledTimes(1);
      expect(mockDispatch).toHaveBeenCalledWith('calculator', {
        expression: '2+2',
      });

      // The tool result must be fed back with matching ids.
      const secondCallParams = (mockCreate.mock.calls[1] as unknown[])[0] as {
        messages: unknown;
        tools: unknown;
      };
      expect(secondCallParams.messages).toEqual([
        { role: 'user', content: '2+2?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'calculator',
              input: { expression: '2+2' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '4' },
          ],
        },
      ]);
      expect(secondCallParams.tools).toEqual([
        {
          name: 'calculator',
          description: 'math',
          input_schema: { type: 'object', properties: {} },
        },
      ]);

      // Every round surfaces its own message_start; usage accumulates into
      // the single terminal message_stop.
      expect(events).toEqual([
        { type: 'message_start', id: 'msg_r', model: 'claude-haiku-4-5' },
        { type: 'tool_use_start', id: 'toolu_1', name: 'calculator' },
        { type: 'tool_use_delta', partialJson: '{"expression":"2+2"}' },
        {
          type: 'tool_use_stop',
          id: 'toolu_1',
          name: 'calculator',
          input: { expression: '2+2' },
        },
        { type: 'message_start', id: 'msg_final', model: 'claude-haiku-4-5' },
        { type: 'text_delta', text: 'The answer is 4' },
        {
          type: 'message_stop',
          stopReason: 'end_turn',
          usage: { inputTokens: 35, outputTokens: 20 },
        },
      ]);
    });

    it('rejects when no tools are registered', async () => {
      jest.spyOn(toolRegistry, 'hasTools').mockImplementation(() => false);

      await expect(
        service.streamWithTools({ message: 'hi' }).next(),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects message combined with messages', async () => {
      await expect(
        service
          .streamWithTools({
            message: 'Hi',
            messages: [{ role: 'user', content: 'Hi again' }],
          })
          .next(),
      ).rejects.toThrow(BadRequestException);
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
