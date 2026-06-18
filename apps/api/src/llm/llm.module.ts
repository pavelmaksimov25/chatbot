import { Module } from '@nestjs/common';
import { AdmissionControlledAdapter } from './admission.adapter';
import { AnthropicProvider } from './anthropic.provider';
import { FallbackLlmAdapter } from './fallback.adapter';
import { GeminiProvider } from './gemini.provider';
import { LLM_ADAPTER, LLM_PROVIDERS } from './llm-adapter';
import { OpenAiProvider } from './openai.provider';
import { ProviderLimitsRegistry } from './provider-limits';

/** The whole LLM stack behind one token, shared by chat and async workers. */
@Module({
  providers: [
    ProviderLimitsRegistry,
    AnthropicProvider,
    OpenAiProvider,
    GeminiProvider,
    {
      provide: LLM_PROVIDERS,
      // Availability-first order: primary, then fallbacks. Fixed by design.
      useFactory: (
        anthropic: AnthropicProvider,
        openai: OpenAiProvider,
        gemini: GeminiProvider,
      ) => [anthropic, openai, gemini],
      inject: [AnthropicProvider, OpenAiProvider, GeminiProvider],
    },
    FallbackLlmAdapter,
    // Admission control wraps fallback: slot → provider walk → stream.
    { provide: LLM_ADAPTER, useClass: AdmissionControlledAdapter },
  ],
  exports: [LLM_ADAPTER],
})
export class LlmModule {}
