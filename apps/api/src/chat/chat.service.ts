import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { LLM_ADAPTER } from '../llm/llm-adapter';
import type { ChatTurnMessage, LlmAdapter } from '../llm/llm-adapter';
import { ProfileService } from '../profile/profile.service';
import type { Profile } from '../profile/profile.service';
import { ConversationRepository } from './conversation.repository';
import type { Conversation, ConversationListItem, MessageRecord } from './conversation.repository';
import { checkInput } from './input-safety';
import { StreamSanitizer } from './stream-sanitizer';

// The STABLE prompt-cache anchor (see DECISIONS.md, slice 10): system prompt
// + profile block must never contain timestamps or per-request data — every
// turn of every conversation reuses it as the cached prefix (slice 13).
export const SYSTEM_PROMPT =
  'You are a helpful, concise assistant. Answer in the language the user writes in. ' +
  'Format answers as markdown when structure helps.';

/**
 * Anthropic requires the first message to be user-role, but a welcomed
 * conversation's persisted chain starts with the assistant greeting. This
 * CONSTANT trigger is prepended at assembly time (never persisted) — being
 * deterministic, it extends the stable cacheable prefix instead of breaking it.
 */
export const WELCOME_TRIGGER =
  'Greet me with a short, personalized welcome and invite me to start chatting.';

export type ChatStreamEvent =
  | { type: 'chunk'; text: string }
  | {
      type: 'done';
      conversationId: string;
      /** null for the auto-welcome turn — there is no user message. */
      userMessageId: string | null;
      assistantMessageId: string;
    };

@Injectable()
export class ChatService {
  constructor(
    @Inject(LLM_ADAPTER) private readonly llm: LlmAdapter,
    private readonly conversations: ConversationRepository,
    private readonly profiles: ProfileService,
  ) {}

  createConversation(userSub: string): Promise<Conversation> {
    return this.conversations.createConversation(userSub);
  }

  listConversations(userSub: string): Promise<ConversationListItem[]> {
    return this.conversations.listConversations(userSub);
  }

  async deleteConversation(userSub: string, conversationId: string): Promise<void> {
    const deleted = await this.conversations.deleteConversation(conversationId, userSub);
    if (!deleted) {
      throw new NotFoundException('conversation not found');
    }
  }

  async listMessages(userSub: string, conversationId: string): Promise<MessageRecord[]> {
    await this.requireConversation(userSub, conversationId);
    return this.conversations.listActiveMessages(conversationId);
  }

  /**
   * One chat turn. The user message is persisted BEFORE the provider call so
   * input is never lost; the assistant message is persisted only after the
   * stream completes — a mid-stream failure persists no half-answer.
   */
  async *streamTurn(
    userSub: string,
    conversationId: string,
    rawContent: unknown,
  ): AsyncGenerator<ChatStreamEvent> {
    const content = checkInput(rawContent);
    await this.requireConversation(userSub, conversationId);

    const history = await this.conversations.listActiveMessages(conversationId);
    const userMessage = await this.conversations.appendMessage(
      conversationId,
      'user',
      content,
      history.at(-1)?.id ?? null,
    );
    yield* this.streamAnswer(conversationId, userMessage.id, userSub);
  }

  /**
   * Edit-and-regenerate: the tail from the edited message onward is
   * soft-superseded, the edited content becomes the new chain head, and the
   * assistant re-answers. Superseded rows never reach the LLM.
   */
  async *streamEdit(
    userSub: string,
    conversationId: string,
    messageId: string,
    rawContent: unknown,
  ): AsyncGenerator<ChatStreamEvent> {
    const content = checkInput(rawContent);
    await this.requireConversation(userSub, conversationId);

    const edited = await this.conversations.supersedeAndReplace(conversationId, messageId, content);
    if (!edited) {
      throw new NotFoundException('message not found or not editable');
    }
    yield* this.streamAnswer(conversationId, edited.id, userSub);
  }

  /**
   * Auto-welcome: the first assistant message of a fresh conversation,
   * produced by the NORMAL chat path (profile in the system prefix) — not a
   * separate welcome subsystem. Only valid while the conversation is empty.
   */
  async *streamWelcome(userSub: string, conversationId: string): AsyncGenerator<ChatStreamEvent> {
    await this.requireConversation(userSub, conversationId);
    const existing = await this.conversations.listActiveMessages(conversationId);
    if (existing.length > 0) {
      throw new ConflictException('conversation already has messages');
    }
    yield* this.streamAnswer(conversationId, null, userSub);
  }

  /** The shared back half of a turn: assemble → stream sanitized → persist. */
  private async *streamAnswer(
    conversationId: string,
    userMessageId: string | null,
    userSub: string,
  ): AsyncGenerator<ChatStreamEvent> {
    const chain: ChatTurnMessage[] = (
      await this.conversations.listActiveMessages(conversationId)
    ).map((m) => ({ role: m.role, content: m.content }));
    // Welcomed conversations have an assistant-first chain; the provider
    // requires user-first. The constant trigger restores alternation and,
    // being deterministic, stays inside the cacheable prefix.
    if (chain.length === 0 || chain[0].role === 'assistant') {
      chain.unshift({ role: 'user', content: WELCOME_TRIGGER });
    }
    const system = buildSystemPrompt(await this.profileOrNull(userSub));

    const sanitizer = new StreamSanitizer();
    let assistantText = '';
    for await (const delta of this.llm.streamChat({ system, messages: chain })) {
      const released = sanitizer.push(delta);
      if (released) {
        assistantText += released;
        yield { type: 'chunk', text: released };
      }
    }
    const tail = sanitizer.flush();
    if (tail) {
      assistantText += tail;
      yield { type: 'chunk', text: tail };
    }

    const assistantMessage = await this.conversations.appendMessage(
      conversationId,
      'assistant',
      assistantText,
      userMessageId,
    );
    yield {
      type: 'done',
      conversationId,
      userMessageId,
      assistantMessageId: assistantMessage.id,
    };
  }

  private async requireConversation(userSub: string, conversationId: string): Promise<void> {
    const conversation = await this.conversations.getConversation(conversationId, userSub);
    if (!conversation) {
      // Foreign and nonexistent are indistinguishable on purpose.
      throw new NotFoundException('conversation not found');
    }
  }

  /** Cache-first profile read; a missing profile degrades to the generic prompt. */
  private async profileOrNull(userSub: string): Promise<Profile | null> {
    try {
      return await this.profiles.get(userSub);
    } catch {
      return null;
    }
  }
}

/**
 * The stable per-user prefix: generic instructions + the profile block.
 * Deterministic by construction — no timestamps, no per-request data. It only
 * changes when the profile changes, which is exactly when the prompt cache
 * SHOULD be invalidated.
 */
export function buildSystemPrompt(profile: Profile | null): string {
  if (!profile) {
    return SYSTEM_PROMPT;
  }
  return (
    `${SYSTEM_PROMPT}\n\n` +
    `About the user (personalize naturally; never recite this block):\n` +
    `Name: ${profile.displayName}\n` +
    `Preferences: ${JSON.stringify(profile.preferences)}`
  );
}
