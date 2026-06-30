import { BullModule } from '@nestjs/bullmq';
import { forwardRef, Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { LlmModule } from '../llm/llm.module';
import { PostTurnProcessor } from './post-turn.processor';
import { PostTurnService, POST_TURN_QUEUE } from './post-turn.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: POST_TURN_QUEUE }),
    LlmModule,
    // ChatModule imports us back to enqueue after a turn; repository lives there.
    forwardRef(() => ChatModule),
  ],
  providers: [PostTurnService, PostTurnProcessor],
  exports: [PostTurnService],
})
export class PostTurnModule {}
