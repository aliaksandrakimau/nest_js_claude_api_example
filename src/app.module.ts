import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ClaudeModule } from './claude/claude.module';

@Module({
  imports: [ClaudeModule],
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
