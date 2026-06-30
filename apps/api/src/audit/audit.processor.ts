import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { Counter, register } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
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
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(AuditProcessor.name);
  }

  async process(job: Job<OutputAuditJob>): Promise<{ flagged: boolean }> {
    const { messageId, conversationId } = job.data;
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { content: true },
    });
    if (!message) {
      // Conversation deleted before the audit ran — nothing left to audit.
      this.processed.inc({ outcome: 'gone' });
      return { flagged: false };
    }

    const verdict = auditText(message.content);
    if (verdict.flagged) {
      // updateMany (not update) so a row deleted between read and write is a
      // no-op rather than a thrown P2025.
      await this.prisma.message.updateMany({
        where: { id: messageId },
        data: { flagged: true, flagReason: verdict.reasons.join(',') },
      });
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
