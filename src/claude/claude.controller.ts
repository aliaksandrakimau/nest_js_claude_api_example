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
import { PinoLogger } from 'nestjs-pino';
import { ClaudeService } from './claude.service';
import {
  ChatRequestDto,
  ConversationRequestDto,
  SendMessageRequestDto,
  StreamRequestDto,
} from './dto';
import type { ClaudeModel, ClaudeResponse } from './interfaces';

// Webhook deliveries give up after this long waiting for the receiver.
const WEBHOOK_TIMEOUT_MS = 10_000;

@Controller('claude')
export class ClaudeController {
  constructor(
    private readonly claudeService: ClaudeService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('ClaudeController');
  }

  @Post('message')
  sendMessage(@Body() request: SendMessageRequestDto): Promise<ClaudeResponse> {
    return this.claudeService.sendMessage(request);
  }

  @Post('conversation')
  createConversation(
    @Body() request: ConversationRequestDto,
  ): Promise<ClaudeResponse> {
    return this.claudeService.createConversation(request);
  }

  // Normalized stream: three aggregated event shapes, one JSON payload per
  // `data:` frame. Easiest to consume; see /claude/raw-stream for fidelity.
  // With callbackUrl the request switches to webhook mode instead.
  @Post('stream')
  async streamCompletion(
    @Body() request: StreamRequestDto,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    if (request.callbackUrl) {
      await this.acceptWebhook(res, () =>
        this.drain(this.claudeService.streamMessage(request)),
      ).deliver(request.callbackUrl);
      return;
    }
    await this.writeSse(
      res,
      this.claudeService.streamMessage(request),
      (event) => `data: ${JSON.stringify(event)}\n\n`,
    );
  }

  // Raw pass-through: forwards the full Anthropic protocol unchanged. Each
  // frame mirrors the upstream wire format exactly — an `event:` line naming
  // the type plus the untouched JSON payload on a `data:` line. SSE only:
  // raw events have no webhook mode.
  @Post('raw-stream')
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

  // Agent endpoint: like /stream, but tool calls requested by the model are
  // run automatically against the registered handlers; the conversation
  // continues until the model produces a final answer. Emits the same
  // normalized event shapes as /claude/stream. Supports webhook mode too.
  @Post('chat')
  async chatCompletion(
    @Body() request: ChatRequestDto,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    if (request.callbackUrl) {
      await this.acceptWebhook(res, () =>
        this.drain(this.claudeService.streamWithTools(request)),
      ).deliver(request.callbackUrl);
      return;
    }
    await this.writeSse(
      res,
      this.claudeService.streamWithTools(request),
      (event) => `data: ${JSON.stringify(event)}\n\n`,
    );
  }

  // Webhook mode plumbing: acknowledge with 202 right away, keep generating
  // in the background and POST the collected events to the callback URL when
  // done (or when generation fails midway). Returns an object so callers can
  // await delivery without blocking the 202 response itself.
  private acceptWebhook(
    res: ExpressResponse,
    collect: () => Promise<{ events: unknown[]; error?: string }>,
  ): { deliver: (callbackUrl: string) => Promise<void> } {
    res.status(202).json({ accepted: true });
    return {
      deliver: async (callbackUrl) => {
        const result = await collect();
        try {
          const response = await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
          });
          if (!response.ok) {
            this.logger.warn(
              { callbackUrl, status: response.status },
              'webhook receiver rejected the delivery',
            );
          }
        } catch (error) {
          this.logger.warn(
            {
              callbackUrl,
              reason: error instanceof Error ? error.message : String(error),
            },
            'webhook delivery failed',
          );
        }
      },
    };
  }

  // Consumes a normalized event generator to completion for webhook mode.
  private async drain<T extends { type: string }>(
    events: AsyncIterable<T>,
  ): Promise<{ events: T[]; error?: string }> {
    const collected: T[] = [];
    try {
      for await (const event of events) {
        collected.push(event);
      }
    } catch (error) {
      collected.push({
        type: 'error',
        message:
          error instanceof Error ? error.message : 'Anthropic stream failed',
      } as T);
    }
    return { events: collected };
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

  @Get('models')
  listModels(): Promise<ClaudeModel[]> {
    return this.claudeService.listModels();
  }
}
