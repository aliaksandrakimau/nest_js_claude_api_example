import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ClaudeService } from './claude/claude.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [ClaudeService]
})
export class AppModule {}
