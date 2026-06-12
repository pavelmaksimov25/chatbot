import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { AnthropicAdapter } from '../llm/anthropic.adapter';
import { LLM_ADAPTER } from '../llm/llm-adapter';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ConversationRepository } from './conversation.repository';

@Module({
  imports: [DbModule],
  controllers: [ChatController],
  providers: [
    ChatService,
    ConversationRepository,
    { provide: LLM_ADAPTER, useClass: AnthropicAdapter },
  ],
})
export class ChatModule {}
