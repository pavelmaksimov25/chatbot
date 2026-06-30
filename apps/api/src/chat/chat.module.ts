import { forwardRef, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FileModule } from '../files/file.module';
import { LlmModule } from '../llm/llm.module';
import { PostTurnModule } from '../post-turn/post-turn.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProfileModule } from '../profile/profile.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { ConversationRepository } from './conversation.repository';

@Module({
  imports: [
    AuditModule,
    PrismaModule,
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
