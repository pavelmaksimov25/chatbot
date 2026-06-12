import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { LLM_ADAPTER } from '../llm/llm-adapter';
import type { ChatTurnMessage, LlmAdapter } from '../llm/llm-adapter';
import { ConversationRepository } from './conversation.repository';
import type { Conversation, ConversationListItem, MessageRecord } from './conversation.repository';
import { checkInput } from './input-safety';
import { StreamSanitizer } from './stream-sanitizer';

// Fixed for this slice; becomes the stable cached prefix (+ per-user welcome
// content) in slices 10/13 — which is why it already sits at the front.
export const SYSTEM_PROMPT =
  'You are a helpful, concise assistant. Answer in the language the user writes in. ' +
  'Format answers as markdown when structure helps.';

export type ChatStreamEvent =
  | { type: 'chunk'; text: string }
  | {
      type: 'done';
      conversationId: string;
      userMessageId: string;
      assistantMessageId: string;
    };

@Injectable()
export class ChatService {
  constructor(
    @Inject(LLM_ADAPTER) private readonly llm: LlmAdapter,
    private readonly conversations: ConversationRepository,
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
    yield* this.streamAnswer(conversationId, userMessage.id);
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
    yield* this.streamAnswer(conversationId, edited.id);
  }

  /** The shared back half of a turn: assemble → stream sanitized → persist. */
  private async *streamAnswer(
    conversationId: string,
    userMessageId: string,
  ): AsyncGenerator<ChatStreamEvent> {
    const chain: ChatTurnMessage[] = (
      await this.conversations.listActiveMessages(conversationId)
    ).map((m) => ({ role: m.role, content: m.content }));

    const sanitizer = new StreamSanitizer();
    let assistantText = '';
    for await (const delta of this.llm.streamChat({ system: SYSTEM_PROMPT, messages: chain })) {
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
}
