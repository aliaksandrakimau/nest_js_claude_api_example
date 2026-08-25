import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ClaudeModule } from './claude/claude.module';
import { ToolsModule } from './claude/tools/tools.module';
import { CalculatorTool } from './claude/tools/example-tool';

// Pretty console output only for local development; production emits raw
// NDJSON (what log shippers expect) and tests stay silent.
const isDev =
  process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
        ...(isDev
          ? {
              transport: {
                target: 'pino-pretty',
                options: { colorize: true, singleLine: true },
              },
            }
          : {}),
      },
    }),
    ClaudeModule,
    ToolsModule.forRoot([CalculatorTool]),
  ],
  providers: [
    {
      // Registered as a provider so e2e tests get the same validation setup.
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
