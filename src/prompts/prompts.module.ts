import { Global, Module } from '@nestjs/common';
import { PromptsController } from './prompts.controller';
import { PromptStoreService } from './prompt-store.service';

// Global so ClaudeService can resolve promptName references from any module.
@Global()
@Module({
  controllers: [PromptsController],
  providers: [PromptStoreService],
  exports: [PromptStoreService],
})
export class PromptsModule {}
