import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { LLM_ADAPTER } from '../llm/llm-adapter';
import type { ChatTurnMessage, LlmAdapter } from '../llm/llm-adapter';
import { ConversationRepository } from './conversation.repository';
import type { Conversation, MessageRecord } from './conversation.repository';
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

    const chain: ChatTurnMessage[] = [...history, userMessage].map((m) => ({
      role: m.role,
      content: m.content,
    }));

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
      userMessage.id,
    );
    yield {
      type: 'done',
      conversationId,
      userMessageId: userMessage.id,
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
