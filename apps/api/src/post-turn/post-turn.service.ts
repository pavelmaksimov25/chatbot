import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

export const POST_TURN_QUEUE = 'post-turn';

export interface PostTurnJob {
  conversationId: string;
  assistantMessageId: string;
  userSub: string;
}

/**
 * Producer for the cheap-model jobs that run AFTER an answer streamed:
 * suggestion chips and the conversation title. Fire-and-forget by the same
 * contract as the audit — they must never delay or fail a finished turn.
 */
@Injectable()
export class PostTurnService {
  constructor(
    @InjectQueue(POST_TURN_QUEUE) private readonly queue: Queue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PostTurnService.name);
  }

  enqueuePostTurn(job: PostTurnJob): void {
    const opts = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: false,
    };
    void Promise.all([
      this.queue.add('suggestions', job, opts),
      // The processor itself skips titled conversations — enqueueing is dumb.
      this.queue.add('title', job, opts),
    ]).catch((err: Error) => {
      this.logger.error(
        { err: err.message, conversationId: job.conversationId },
        'post-turn jobs could not be enqueued — turn unaffected',
      );
    });
  }
}
