import type { LlmTier } from './llm-adapter';

/**
 * Tier → model per provider (see DECISIONS.md, slice 11). Env-overridable so
 * a vendor's model churn never needs a code change. A fallback stays on the
 * SAME tier — quality/cost jumps must be explicit, never a side effect.
 */
const DEFAULTS: Record<string, Record<LlmTier, string>> = {
  anthropic: { default: 'claude-sonnet-4-6', cheap: 'claude-haiku-4-5' },
  openai: { default: 'gpt-5', cheap: 'gpt-5-mini' },
  gemini: { default: 'gemini-2.5-pro', cheap: 'gemini-2.5-flash' },
};

const ENV_OVERRIDES: Record<string, Record<LlmTier, string>> = {
  anthropic: { default: 'LLM_MODEL', cheap: 'LLM_MODEL_CHEAP' },
  openai: { default: 'OPENAI_MODEL', cheap: 'OPENAI_MODEL_CHEAP' },
  gemini: { default: 'GEMINI_MODEL', cheap: 'GEMINI_MODEL_CHEAP' },
};

export function modelFor(provider: keyof typeof DEFAULTS, tier: LlmTier = 'default'): string {
  return process.env[ENV_OVERRIDES[provider][tier]] || DEFAULTS[provider][tier];
}

export const MAX_TOKENS = (): number => Number(process.env.LLM_MAX_TOKENS ?? 1024);
