import { BadRequestException } from '@nestjs/common';
import { ProviderRegistryService } from './provider-registry.service';

describe('ProviderRegistryService', () => {
  const anthropicProvider = { name: 'anthropic' };
  const logger = Object.assign(jest.fn(), {
    setContext: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  });

  function makeRegistry(openAiConfigured: boolean): ProviderRegistryService {
    const openAiProvider = {
      name: 'openai',
      isConfigured: () => openAiConfigured,
    };
    return new ProviderRegistryService(
      anthropicProvider as never,
      openAiProvider as never,
      logger as never,
    );
  }

  it('routes claude models to the native provider', () => {
    const registry = makeRegistry(true);
    expect(registry.resolve('claude-haiku-4-5')).toEqual({
      provider: anthropicProvider,
      model: 'claude-haiku-4-5',
    });
  });

  it('routes explicit anthropic/ models and strips the prefix', () => {
    const registry = makeRegistry(false);
    expect(registry.resolve('anthropic/claude-opus-4-6')).toEqual({
      provider: anthropicProvider,
      model: 'claude-opus-4-6',
    });
  });

  it('routes openai/ models to the third-party provider and strips the prefix', () => {
    const registry = makeRegistry(true);
    const route = registry.resolve('openai/gpt-4o-mini');
    expect(route.model).toBe('gpt-4o-mini');
    expect(route.provider.name).toBe('openai');
  });

  it('rejects openai/ models when no endpoint is configured', () => {
    const registry = makeRegistry(false);
    expect(() => registry.resolve('openai/gpt-4o-mini')).toThrow(
      BadRequestException,
    );
  });

  it('sends unqualified foreign ids to the configured endpoint', () => {
    const registry = makeRegistry(true);
    expect(registry.resolve('gpt-4o')).toMatchObject({ model: 'gpt-4o' });
    expect(registry.resolve('gpt-4o').provider.name).toBe('openai');
  });

  it('falls back to the native provider for unknown ids otherwise', () => {
    const registry = makeRegistry(false);
    expect(registry.resolve('mystery-model').provider.name).toBe('anthropic');
  });

  it('lists only the native provider until an endpoint is configured', () => {
    expect(makeRegistry(false).providers()).toHaveLength(1);
    expect(makeRegistry(true).providers()).toHaveLength(2);
  });
});
