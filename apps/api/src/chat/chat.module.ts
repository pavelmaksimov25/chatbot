import { forwardRef, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DbModule } from '../db/db.module';
import { FileModule } from '../files/file.module';
import { LlmModule } from '../llm/llm.module';
import { PostTurnModule } from '../post-turn/post-turn.module';
import { ProfileModule } from '../profile/profile.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ConversationRepository } from './conversation.repository';

@Module({
  imports: [
    AuditModule,
    DbModule,
    FileModule,
    LlmModule,
    forwardRef(() => PostTurnModule),
    ProfileModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, ConversationRepository],
  exports: [ConversationRepository],
})
export class ChatModule {}
