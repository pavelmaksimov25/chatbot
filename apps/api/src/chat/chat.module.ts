import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AnthropicProvider } from '../llm/anthropic.provider';
import { FallbackLlmAdapter } from '../llm/fallback.adapter';
import { GeminiProvider } from '../llm/gemini.provider';
import { LLM_ADAPTER, LLM_PROVIDERS } from '../llm/llm-adapter';
import { OpenAiProvider } from '../llm/openai.provider';
import { ProfileModule } from '../profile/profile.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ConversationRepository } from './conversation.repository';

@Module({
  imports: [DbModule, ProfileModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ConversationRepository,
    AnthropicProvider,
    OpenAiProvider,
    GeminiProvider,
    {
      provide: LLM_PROVIDERS,
      // Availability-first order: primary, then fallbacks. Fixed by design.
      useFactory: (anthropic: AnthropicProvider, openai: OpenAiProvider, gemini: GeminiProvider) =>
        [anthropic, openai, gemini],
      inject: [AnthropicProvider, OpenAiProvider, GeminiProvider],
    },
    { provide: LLM_ADAPTER, useClass: FallbackLlmAdapter },
  ],
})
export class ChatModule {}
