import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { ConversationRepository } from '../chat/conversation.repository';
import { LLM_ADAPTER } from '../llm/llm-adapter';
import type { ChatTurnMessage, LlmAdapter } from '../llm/llm-adapter';
import { POST_TURN_QUEUE } from './post-turn.service';
import type { PostTurnJob } from './post-turn.service';

const MAX_CONTEXT_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 500;
const MAX_CHIP_CHARS = 80;
const MAX_TITLE_CHARS = 60;

const SUGGESTIONS_PROMPT =
  'You suggest follow-up messages. Given the conversation, respond with ONLY a JSON array ' +
  'of 2 to 3 short follow-up questions the user might plausibly send next, each under ' +
  `${MAX_CHIP_CHARS} characters. No prose, no code fences — just the JSON array.`;

const TITLE_PROMPT =
  'Name this conversation. Respond with ONLY a short title of 3 to 6 words — ' +
  'no quotes, no punctuation at the end, no explanations.';

/** Cheap-tier (Haiku-class) consumers for the post-turn queue. */
@Processor(POST_TURN_QUEUE)
export class PostTurnProcessor extends WorkerHost {
  constructor(
    @Inject(LLM_ADAPTER) private readonly llm: LlmAdapter,
    private readonly conversations: ConversationRepository,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(PostTurnProcessor.name);
  }

  async process(job: Job<PostTurnJob>): Promise<void> {
    if (job.name === 'suggestions') {
      return this.suggestions(job.data);
    }
    if (job.name === 'title') {
      return this.title(job.data);
    }
  }

  private async suggestions(job: PostTurnJob): Promise<void> {
    const context = await this.context(job.conversationId);
    if (context.length === 0) {
      return;
    }
    const raw = await this.complete(SUGGESTIONS_PROMPT, context);
    const chips = parseChips(raw);
    if (chips.length === 0) {
      // Let the retry take another shot — models are nondeterministic.
      throw new Error(`unparseable suggestions: ${raw.slice(0, 120)}`);
    }
    await this.conversations.setSuggestions(job.conversationId, job.assistantMessageId, chips);
    this.logger.info({ conversationId: job.conversationId, chips: chips.length }, 'chips ready');
  }

  private async title(job: PostTurnJob): Promise<void> {
    const context = await this.context(job.conversationId);
    if (context.length === 0) {
      return;
    }
    const raw = await this.complete(TITLE_PROMPT, context);
    const title = sanitizeTitle(raw);
    if (!title) {
      throw new Error(`unusable title: ${raw.slice(0, 120)}`);
    }
    const applied = await this.conversations.setTitleIfEmpty(job.conversationId, title);
    if (applied) {
      this.logger.info({ conversationId: job.conversationId, title }, 'conversation titled');
    }
  }

  /** Trimmed text-only view of the active chain — cheap jobs, cheap context. */
  private async context(conversationId: string): Promise<ChatTurnMessage[]> {
    const records = await this.conversations.listActiveMessages(conversationId);
    return records.slice(-MAX_CONTEXT_MESSAGES).map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    }));
  }

  private async complete(system: string, messages: ChatTurnMessage[]): Promise<string> {
    let text = '';
    for await (const delta of this.llm.streamChat({ system, messages, tier: 'cheap' })) {
      text += delta;
    }
    return text.trim();
  }
}

/** Defensive JSON-array extraction — models love decorating their output. */
export function parseChips(raw: string): string[] {
  const match = /\[[\s\S]*\]/.exec(raw);
  if (!match) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((chip): chip is string => typeof chip === 'string')
      .map((chip) => chip.trim())
      .filter((chip) => chip.length > 0 && chip.length <= MAX_CHIP_CHARS)
      .slice(0, 3);
  } catch {
    return [];
  }
}

export function sanitizeTitle(raw: string): string {
  return raw
    .replace(/["'`*#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .replace(/[.:!,;]+$/, '');
}
