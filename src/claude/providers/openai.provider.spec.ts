import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { OpenAiProvider } from './openai.provider';

// Shape expected by the provider from the Anthropic-style internal request.
const REQUEST = {
  model: 'gpt-4o-mini',
  messages: [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me calculate.' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'calculator',
          input: { expression: '2+2' },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '4' }],
    },
  ] as never,
  system: 'Be brief.',
  maxTokens: 250,
  temperature: 0.2,
  tools: [
    {
      name: 'calculator',
      description: 'math',
      input_schema: { type: 'object', properties: {} },
    },
  ] as never,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe('OpenAiProvider', () => {
  let provider: OpenAiProvider;
  const fetchMock = jest.fn<(...args: unknown[]) => Promise<Response>>();

  // Parses the request body the provider sent to the mocked endpoint.
  function sentBody(): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    return JSON.parse(init.body) as Record<string, unknown>;
  }
  const originalKey = process.env.OPENAI_API_KEY;
  const originalBaseUrl = process.env.OPENAI_BASE_URL;
  const realFetch = global.fetch;

  beforeAll(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'http://test.local/v1';
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = originalBaseUrl;
    }
  });

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    // Silent logger stub; config reads straight from process.env so tests can
    // drive the key/base URL lifecycle.
    provider = new OpenAiProvider(
      { get: (key: string) => process.env[key] } as unknown as ConfigService,
      Object.assign(jest.fn(), {
        setContext: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }) as unknown as PinoLogger,
    );
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('isConfigured', () => {
    it('reflects the presence of the API key', () => {
      expect(provider.isConfigured()).toBe(true);
      delete process.env.OPENAI_API_KEY;
      expect(provider.isConfigured()).toBe(false);
    });
  });

  describe('createMessage', () => {
    it('translates the internal format to the OpenAI wire format', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          id: 'chatcmpl_1',
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'It is 4' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 4 },
        }),
      );

      await expect(provider.createMessage(REQUEST)).resolves.toEqual({
        id: 'chatcmpl_1',
        model: 'gpt-4o-mini',
        role: 'assistant',
        text: 'It is 4',
        stopReason: 'end_turn',
        usage: { inputTokens: 20, outputTokens: 4 },
      });

      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('http://test.local/v1/chat/completions');
      expect(init.method).toBe('POST');

      expect(sentBody()).toEqual({
        model: 'gpt-4o-mini',
        max_tokens: 250,
        temperature: 0.2,
        messages: [
          // System becomes a leading message.
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: 'Let me calculate.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'calculator',
                  arguments: '{"expression":"2+2"}',
                },
              },
            ],
          },
          // Tool results become standalone tool messages.
          { role: 'tool', tool_call_id: 'call_1', content: '4' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'calculator',
              description: 'math',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        tool_choice: 'auto',
      });
    });

    it.each([
      ['stop', 'end_turn'],
      ['length', 'max_tokens'],
      ['tool_calls', 'tool_use'],
      ['content_filter', 'content_filter'],
      [null, null],
    ])('maps finish_reason %s to %s', async (reason, expected) => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          id: 'chatcmpl_2',
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'x' }, finish_reason: reason }],
        }),
      );

      const response = await provider.createMessage(REQUEST);
      expect(response.stopReason).toBe(expected);
      // Usage degrades to zeros when the endpoint omits it.
      expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
  });

  describe('streamMessage', () => {
    it('normalizes the chunk protocol, including tool calls', async () => {
      fetchMock.mockResolvedValue(
        sseResponse([
          {
            id: 'chatcmpl_3',
            model: 'gpt-4o-mini',
            choices: [{ delta: { role: 'assistant' } }],
          },
          { choices: [{ delta: { content: 'The answer is ' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_9',
                      function: { name: 'calculator', arguments: '' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '{"expression"' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: ':"2+2"}' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 15 },
          },
        ]),
      );

      const events = [];
      for await (const event of provider.streamMessage(REQUEST)) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: 'message_start', id: 'chatcmpl_3', model: 'gpt-4o-mini' },
        { type: 'text_delta', text: 'The answer is ' },
        { type: 'tool_use_start', id: 'call_9', name: 'calculator' },
        { type: 'tool_use_delta', partialJson: '{"expression"' },
        { type: 'tool_use_delta', partialJson: ':"2+2"}' },
        {
          type: 'tool_use_stop',
          id: 'call_9',
          name: 'calculator',
          input: { expression: '2+2' },
        },
        {
          type: 'message_stop',
          stopReason: 'tool_use',
          usage: { inputTokens: 5, outputTokens: 15 },
        },
      ]);

      // Streaming requests ask for usage and carry the tools.
      const body = sentBody();
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.tools).toHaveLength(1);
    });

    it('aborts the upstream request when the consumer leaves early', async () => {
      // A stream that never completes: the only way out is aborting.
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      fetchMock.mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: 'chatcmpl_4',
                    model: 'gpt-4o-mini',
                    choices: [{ delta: { content: 'Hi' } }],
                  })}\n\n`,
                ),
              );
            },
          }),
        ),
      );

      for await (const event of provider.streamMessage(REQUEST)) {
        expect(event.type).toBe('message_start');
        break;
      }

      const [, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect((init.signal as AbortSignal).aborted).toBe(true);
      void streamController;
    });
  });

  describe('error mapping', () => {
    it.each([
      ['401 to 503', 401, ServiceUnavailableException],
      ['403 to 503', 403, ServiceUnavailableException],
      ['429 to 429', 429, HttpException],
      ['400 to 400', 400, BadRequestException],
      ['404 to 400', 404, BadRequestException],
      ['500 to 502', 500, HttpException],
    ])('maps %s', async (_name, status, expectedException) => {
      fetchMock.mockResolvedValue(
        jsonResponse({ error: { message: 'upstream said no' } }, status),
      );

      const rejection = provider.createMessage(REQUEST);
      await expect(rejection).rejects.toBeInstanceOf(expectedException);
      await rejection.catch((error) => {
        const message = (error as Error).message;
        if (status === 400 || status === 404 || status === 500) {
          expect(message).toContain('upstream said no');
        }
      });
    });

    it('surfaces connection failures as 503', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(provider.createMessage(REQUEST)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('listModels', () => {
    it('prefixes ids so they are directly usable as model values', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          data: [{ id: 'gpt-4o-mini', created: 1700000000 }, { id: 'gpt-4o' }],
        }),
      );

      await expect(provider.listModels()).resolves.toEqual([
        {
          id: 'openai/gpt-4o-mini',
          displayName: 'gpt-4o-mini',
          createdAt: new Date(1700000000 * 1000).toISOString(),
        },
        { id: 'openai/gpt-4o', displayName: 'gpt-4o', createdAt: '' },
      ]);
    });
  });
});
