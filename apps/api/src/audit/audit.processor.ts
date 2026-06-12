import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { Counter, register } from 'prom-client';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { auditText } from './audit-policy';
import type { OutputAuditJob } from './audit.service';
import { OUTPUT_AUDIT_QUEUE } from './audit.service';

function counter(name: string, help: string, labelNames: string[] = []): Counter {
  return (register.getSingleMetric(name) as Counter) ?? new Counter({ name, help, labelNames });
}

/** Consumer side: heavier holistic checks AFTER the stream completed. */
@Processor(OUTPUT_AUDIT_QUEUE)
export class AuditProcessor extends WorkerHost {
  private readonly processed = counter('llm_audit_jobs_total', 'Output-audit jobs by outcome', [
    'outcome',
  ]);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(AuditProcessor.name);
  }

  async process(job: Job<OutputAuditJob>): Promise<{ flagged: boolean }> {
    const { messageId, conversationId } = job.data;
    const { rows } = await this.pool.query<{ content: string }>(
      'SELECT content FROM messages WHERE id = $1',
      [messageId],
    );
    if (rows.length === 0) {
      // Conversation deleted before the audit ran — nothing left to audit.
      this.processed.inc({ outcome: 'gone' });
      return { flagged: false };
    }

    const verdict = auditText(rows[0].content);
    if (verdict.flagged) {
      await this.pool.query('UPDATE messages SET flagged = true, flag_reason = $2 WHERE id = $1', [
        messageId,
        verdict.reasons.join(','),
      ]);
      // THE audit log line — what an operator greps/alerts on.
      this.logger.warn(
        { conversationId, messageId, reasons: verdict.reasons },
        'output audit FLAGGED a response',
      );
      this.processed.inc({ outcome: 'flagged' });
    } else {
      this.processed.inc({ outcome: 'clean' });
    }
    return { flagged: verdict.flagged };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<OutputAuditJob> | undefined, error: Error): void {
    this.processed.inc({ outcome: 'failed' });
    this.logger.error(
      {
        messageId: job?.data.messageId,
        attempt: job?.attemptsMade,
        err: error.message,
      },
      'output audit job failed',
    );
  }
}
