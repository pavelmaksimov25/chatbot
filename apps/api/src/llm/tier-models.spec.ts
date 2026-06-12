import { modelFor } from './tier-models';

describe('modelFor', () => {
  const ENV_KEYS = [
    'LLM_MODEL',
    'LLM_MODEL_CHEAP',
    'OPENAI_MODEL',
    'OPENAI_MODEL_CHEAP',
    'GEMINI_MODEL',
    'GEMINI_MODEL_CHEAP',
  ];

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('maps the default tier without quality jumps across providers', () => {
    expect(modelFor('anthropic')).toBe('claude-sonnet-4-6');
    expect(modelFor('openai')).toBe('gpt-5');
    expect(modelFor('gemini')).toBe('gemini-2.5-pro');
  });

  it('maps the cheap tier to the small model of EVERY provider', () => {
    expect(modelFor('anthropic', 'cheap')).toBe('claude-haiku-4-5');
    expect(modelFor('openai', 'cheap')).toBe('gpt-5-mini');
    expect(modelFor('gemini', 'cheap')).toBe('gemini-2.5-flash');
  });

  it('honours env overrides per provider and tier', () => {
    process.env.LLM_MODEL = 'claude-opus-4-8';
    process.env.GEMINI_MODEL_CHEAP = 'gemini-3-flash';
    expect(modelFor('anthropic')).toBe('claude-opus-4-8');
    expect(modelFor('gemini', 'cheap')).toBe('gemini-3-flash');
    // Untouched combinations keep their defaults.
    expect(modelFor('anthropic', 'cheap')).toBe('claude-haiku-4-5');
    expect(modelFor('openai')).toBe('gpt-5');
  });
});
