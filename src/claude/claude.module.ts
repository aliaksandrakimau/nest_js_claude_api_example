import { Module } from '@nestjs/common';
import { ClaudeController } from './claude.controller';
import { ClaudeService } from './claude.service';
import { ModelRouterService } from './model-router.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { ProviderRegistryService } from './providers/provider-registry.service';

@Module({
  controllers: [ClaudeController],
  providers: [
    ClaudeService,
    ModelRouterService,
    AnthropicProvider,
    OpenAiProvider,
    ProviderRegistryService,
  ],
  exports: [ClaudeService],
})
export class ClaudeModule {}
