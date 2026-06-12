import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { Counter, register } from 'prom-client';

export const OUTPUT_AUDIT_QUEUE = 'output-audit';

export interface OutputAuditJob {
  conversationId: string;
  messageId: string;
  userSub: string;
}

function counter(name: string, help: string, labelNames: string[] = []): Counter {
  return (register.getSingleMetric(name) as Counter) ?? new Counter({ name, help, labelNames });
}

/**
 * Producer side of the async tail. Enqueueing is fire-and-forget BY CONTRACT:
 * the audit is a backstop and must never block, delay, or fail a turn that
 * already streamed to the user.
 */
@Injectable()
export class AuditService {
  readonly enqueued = counter('llm_audit_jobs_enqueued_total', 'Output-audit jobs enqueued');
  readonly enqueueFailures = counter(
    'llm_audit_enqueue_failures_total',
    'Output-audit jobs that could not be enqueued',
  );

  constructor(
    @InjectQueue(OUTPUT_AUDIT_QUEUE) private readonly queue: Queue,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AuditService.name);
  }

  enqueueOutputAudit(job: OutputAuditJob): void {
    void this.queue
      .add('audit', job, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: false, // failed jobs stay visible — the minimal "board"
      })
      .then(() => this.enqueued.inc())
      .catch((err: Error) => {
        this.enqueueFailures.inc();
        this.logger.error(
          { err: err.message, messageId: job.messageId },
          'output audit could not be enqueued — turn unaffected',
        );
      });
  }
}
