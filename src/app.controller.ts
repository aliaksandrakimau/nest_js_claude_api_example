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

  // Normalized stream: three aggregated event shapes, one JSON payload per
  // `data:` frame. Easiest to consume; see /claude/raw-stream for fidelity.
  @Post('claude/stream')
  async streamCompletion(
    @Body() request: StreamRequestDto,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    await this.writeSse(
      res,
      this.claudeService.streamMessage(request),
      (event) => `data: ${JSON.stringify(event)}\n\n`,
    );
  }

  // Raw pass-through: forwards the full Anthropic protocol unchanged. Each
  // frame mirrors the upstream wire format exactly — an `event:` line naming
  // the type plus the untouched JSON payload on a `data:` line.
  @Post('claude/raw-stream')
  async streamRawCompletion(
    @Body() request: StreamRequestDto,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    await this.writeSse(
      res,
      this.claudeService.streamRawMessage(request),
      (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  }

  // Shared SSE plumbing for both endpoints. Headers are sent lazily so
  // validation and authentication failures still get regular HTTP error
  // responses; a failure after that can no longer change the status line and
  // is reported as a final `{type:"error"}` frame instead.
  private async writeSse<T extends { type: string }>(
    res: ExpressResponse,
    events: AsyncIterable<T>,
    formatFrame: (event: T | { type: 'error'; message: string }) => string,
  ): Promise<void> {
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

        res.write(formatFrame(event));
      }

      res.end();
    } catch (error) {
      if (!opened) {
        // Nothing was written yet: let the standard exception filters render
        // a normal HTTP error with a meaningful status code.
        throw error;
      }
      const message =
        error instanceof HttpException
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Anthropic stream failed';
      res.write(formatFrame({ type: 'error', message }));
      res.end();
    }
  }

  @Get('claude/models')
  listModels(): Promise<ClaudeModel[]> {
    return this.claudeService.listModels();
  }
}
