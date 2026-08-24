import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AppController } from './app.controller';
import { ClaudeService } from './claude/claude.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    ClaudeService,
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
