import { HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { ClaudeService } from './claude/claude.service';
import type { ClaudeStreamEvent } from './claude/interfaces';
import { ConversationRequestDto } from './claude/dto';

// Minimal async iterable standing in for the service's stream generator.
function streamOf(
  events: ClaudeStreamEvent[],
): AsyncGenerator<ClaudeStreamEvent> {
  let index = 0;
  const iterator = {
    next: (): Promise<IteratorResult<ClaudeStreamEvent>> =>
      index < events.length
        ? Promise.resolve({ done: false, value: events[index++] })
        : Promise.resolve({ done: true, value: undefined }),
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
  } as AsyncGenerator<ClaudeStreamEvent>;
}

function streamThatThrows(error: Error): AsyncGenerator<never> {
  const iterator = {
    next: (): Promise<IteratorResult<never>> => Promise.reject(error),
  };
  return {
    [Symbol.asyncIterator]: () => iterator,
  } as AsyncGenerator<never>;
}

interface SseResponseMock {
  status: jest.Mock;
  set: jest.Mock;
  flushHeaders: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  on: jest.Mock;
  writes: string[];
}

describe('AppController', () => {
  let controller: AppController;
  let claudeService: {
    sendMessage: jest.Mock;
    createConversation: jest.Mock;
    streamMessage: jest.Mock;
    listModels: jest.Mock;
  };

  // Covers everything the SSE handler touches; kept as a plain jest.Mock
  // interface so assertions never touch Express class methods.
  const createResponseMock = (): SseResponseMock => {
    const response: SseResponseMock = {
      status: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      flushHeaders: jest.fn(),
      write: jest.fn((chunk: string) => {
        response.writes.push(chunk);
        return true;
      }),
      end: jest.fn(),
      on: jest.fn(),
      writes: [],
    };
    return response;
  };

  beforeEach(async () => {
    claudeService = {
      sendMessage: jest.fn().mockResolvedValue({}),
      createConversation: jest.fn().mockResolvedValue({}),
      streamMessage: jest.fn(),
      listModels: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: ClaudeService, useValue: claudeService }],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  it('sendMessage delegates to ClaudeService', async () => {
    const request = { message: 'Hi' };

    await controller.sendMessage(request);

    expect(claudeService.sendMessage).toHaveBeenCalledWith(request);
  });

  it('createConversation delegates to ClaudeService', async () => {
    const request = { messages: [{ role: 'user', content: 'Hi' }] };

    await controller.createConversation(request as ConversationRequestDto);

    expect(claudeService.createConversation).toHaveBeenCalledWith(request);
  });

  it('listModels delegates to ClaudeService', async () => {
    await controller.listModels();

    expect(claudeService.listModels).toHaveBeenCalled();
  });

  describe('streamCompletion', () => {
    it('streams every event as an SSE frame', async () => {
      const events: ClaudeStreamEvent[] = [
        { type: 'message_start', id: 'msg_1', model: 'claude-haiku-4-5' },
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        {
          type: 'message_stop',
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 2 },
        },
      ];
      claudeService.streamMessage.mockReturnValue(streamOf(events));
      const res = createResponseMock();

      await controller.streamCompletion(
        { message: 'Hi' },
        res as unknown as Response,
      );

      expect(claudeService.streamMessage).toHaveBeenCalledWith({
        message: 'Hi',
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'text/event-stream; charset=utf-8',
        }),
      );
      expect(
        res.writes.map((frame): unknown =>
          JSON.parse(frame.slice('data: '.length)),
        ),
      ).toEqual(events);
      expect(res.end).toHaveBeenCalled();
    });

    it('rethrows failures that happen before the first frame', async () => {
      claudeService.streamMessage.mockReturnValue(
        streamThatThrows(new HttpException('bad request', 400)),
      );
      const res = createResponseMock();

      await expect(
        controller.streamCompletion(
          { message: 'Hi' },
          res as unknown as Response,
        ),
      ).rejects.toThrow('bad request');

      expect(res.flushHeaders).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });
  });
});
