import { Module } from '@nestjs/common';
import { ClaudeController } from './claude.controller';
import { ClaudeService } from './claude.service';
import { ModelRouterService } from './model-router.service';

@Module({
  controllers: [ClaudeController],
  providers: [ClaudeService, ModelRouterService],
  exports: [ClaudeService],
})
export class ClaudeModule {}
