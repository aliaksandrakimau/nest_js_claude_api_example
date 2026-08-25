import { ModelRouterService } from './model-router.service';

describe('ModelRouterService', () => {
  let router: ModelRouterService;
  const logger = Object.assign(jest.fn(), {
    setContext: jest.fn(),
    debug: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    router = new ModelRouterService(logger as never);
  });

  it('an explicit model always wins', () => {
    expect(router.selectModel('claude-opus-4-6', 'hi')).toBe('claude-opus-4-6');
  });

  it('short plain input goes to the default model', () => {
    expect(router.selectModel(undefined, 'What is 2+2?')).toBe(
      'claude-haiku-4-5',
    );
  });

  it('complexity keywords escalate to the heavier model', () => {
    expect(router.selectModel(undefined, 'Please refactor my module')).toBe(
      'claude-sonnet-4-5',
    );
    expect(
      router.selectModel(undefined, 'Explain the algorithm step by step'),
    ).toBe('claude-sonnet-4-5');
  });

  it('long input escalates regardless of wording', () => {
    expect(router.selectModel(undefined, 'a'.repeat(2001))).toBe(
      'claude-sonnet-4-5',
    );
  });
});
