import {
  Body,
  Controller,
  Get,
  HttpException,
  Post,
  Res,
} from '@nestjs/common';
// Type-only import: a decorated signature must not emit a runtime reference
// to a type-only symbol under isolatedModules + emitDecoratorMetadata.
import type { Response as ExpressResponse } from 'express';
import { ClaudeService } from './claude/claude.service';
import {
  ConversationRequestDto,
  SendMessageRequestDto,
  StreamRequestDto,
} from './claude/dto';
import type { ClaudeModel, ClaudeResponse } from './claude/interfaces';

@Controller()
export class AppController {
  constructor(private readonly claudeService: ClaudeService) {}

  @Post('claude/message')
  sendMessage(@Body() request: SendMessageRequestDto): Promise<ClaudeResponse> {
    return this.claudeService.sendMessage(request);
  }

  @Post('claude/conversation')
  createConversation(
    @Body() request: ConversationRequestDto,
  ): Promise<ClaudeResponse> {
    return this.claudeService.createConversation(request);
  }

  // Streams the answer as server-sent events; each frame is one JSON payload
  // with a `type` discriminator. SSE headers are set only after the service
  // accepted the request, so validation and authentication failures still get
  // regular HTTP error responses.
  @Post('claude/stream')
  async streamCompletion(
    @Body() request: StreamRequestDto,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const events = this.claudeService.streamMessage(request);
    let opened = false;

    try {
      let clientGone = false;
      res.on('close', () => {
        clientGone = true;
      });

      for await (const event of events) {
        if (!opened) {
          res.status(200).set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            // Ask reverse proxies not to buffer the stream.
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders();
          opened = true;
        }

        if (clientGone) {
          break;
        }

        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }

      res.end();
    } catch (error) {
      if (!opened) {
        // Nothing was written yet: let the standard exception filters render
        // a normal HTTP error with a meaningful status code.
        throw error;
      }
      // Mid-stream failures can no longer change the status line, so report
      // them as a final error frame instead.
      const message =
        error instanceof HttpException
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Anthropic stream failed';
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    }
  }

  @Get('claude/models')
  listModels(): Promise<ClaudeModel[]> {
    return this.claudeService.listModels();
  }
}
