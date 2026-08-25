import { BadRequestException, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';
import type { ClaudeModel } from '../interfaces';
import type { ModelProvider, ResolvedRoute } from './provider.interface';

const ANTHROPIC_PREFIX = 'anthropic/';
const OPENAI_PREFIX = 'openai/';

/**
 * Routes a model id to the provider that can execute it:
 *
 * - "claude*" or "anthropic/<id>"  -> native Anthropic provider
 * - "openai/<id>"                  -> OpenAI-compatible endpoint (requires
 *                                    OPENAI_API_KEY)
 * - any other id                   -> the OpenAI-compatible endpoint when one
 *                                    is configured, otherwise Anthropic (which
 *                                    surfaces an upstream unknown-model error)
 */
@Injectable()
export class ProviderRegistryService {
  constructor(
    private readonly anthropic: AnthropicProvider,
    private readonly openai: OpenAiProvider,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext('ProviderRegistryService');
  }

  resolve(model: string): ResolvedRoute {
    if (model.startsWith(ANTHROPIC_PREFIX)) {
      return {
        provider: this.anthropic,
        model: model.slice(ANTHROPIC_PREFIX.length),
      };
    }

    if (model.startsWith(OPENAI_PREFIX)) {
      if (!this.openai.isConfigured()) {
        throw new BadRequestException(
          `Model "${model}" requires OPENAI_API_KEY to be configured`,
        );
      }
      const route = {
        provider: this.openai as ModelProvider,
        model: model.slice(OPENAI_PREFIX.length),
      };
      this.logger.debug({ model: route.model }, 'routed to openai provider');
      return route;
    }

    if (model.startsWith('claude')) {
      return { provider: this.anthropic, model };
    }

    // Unqualified third-party ids go to the configured external endpoint.
    if (this.openai.isConfigured()) {
      this.logger.debug({ model }, 'routed to openai provider');
      return { provider: this.openai, model };
    }

    return { provider: this.anthropic, model };
  }

  // All providers usable right now, native first.
  providers(): ModelProvider[] {
    return this.openai.isConfigured()
      ? [this.anthropic, this.openai]
      : [this.anthropic];
  }

  // Merged model catalog. Anthropic failures propagate (it is the primary
  // provider); a failing third-party endpoint only shrinks the list.
  async listModels(): Promise<ClaudeModel[]> {
    const models = await this.anthropic.listModels();
    if (!this.openai.isConfigured()) {
      return models;
    }
    try {
      return [...models, ...(await this.openai.listModels())];
    } catch (error) {
      this.logger.warn(
        { reason: error instanceof Error ? error.message : String(error) },
        'openai-compatible endpoint did not report models; listing native models only',
      );
      return models;
    }
  }
}
