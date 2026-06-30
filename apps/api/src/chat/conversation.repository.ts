import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface Conversation {
  id: string;
  userSub: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationListItem {
  id: string;
  title: string | null;
  /** First active user message, truncated — the sidebar fallback until titles land (slice 17). */
  preview: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MessageRole = 'user' | 'assistant';

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  seq: number;
  active: boolean;
  parentMessageId: string | null;
  /** Attached file ids (slice 15) — empty for plain text messages. */
  fileIds: string[];
  createdAt: Date;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  seq: number;
  active: boolean;
  parent_message_id: string | null;
  created_at: Date;
}

const MESSAGE_COLUMNS =
  'id, conversation_id, role, content, seq, active, parent_message_id, created_at';

@Injectable()
export class ConversationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createConversation(userSub: string): Promise<Conversation> {
    const conversation = await this.prisma.conversation.create({ data: { userSub } });
    return toConversation(conversation);
  }

  /** Most recently touched first; previews come from the first active user message. */
  async listConversations(userSub: string): Promise<ConversationListItem[]> {
    // Correlated subquery for the preview — kept raw (no clean Client form).
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        title: string | null;
        preview: string | null;
        created_at: Date;
        updated_at: Date;
      }[]
    >`
      SELECT c.id, c.title, c.created_at, c.updated_at,
             (SELECT left(m.content, 80) FROM messages m
               WHERE m.conversation_id = c.id AND m.role = 'user' AND m.active
               ORDER BY m.seq LIMIT 1) AS preview
        FROM conversations c
       WHERE c.user_sub = ${userSub}
       ORDER BY c.updated_at DESC`;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      preview: row.preview,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Chips for the LATEST answer only; forMessageId tells the SPA which one. */
  async setSuggestions(
    conversationId: string,
    forMessageId: string,
    suggestions: string[],
  ): Promise<void> {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId },
      data: { suggestions, suggestionsFor: forMessageId },
    });
  }

  async getSuggestions(
    conversationId: string,
    userSub: string,
  ): Promise<{ forMessageId: string | null; suggestions: string[] } | null> {
    const row = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userSub },
      select: { suggestions: true, suggestionsFor: true },
    });
    return row ? { forMessageId: row.suggestionsFor, suggestions: row.suggestions } : null;
  }

  /** First generated title wins; a user-visible title is never overwritten. */
  async setTitleIfEmpty(conversationId: string, title: string): Promise<boolean> {
    const { count } = await this.prisma.conversation.updateMany({
      where: { id: conversationId, title: null },
      data: { title },
    });
    return count > 0;
  }

  /** Hard delete; messages go with it (FK CASCADE). Foreign = not found. */
  async deleteConversation(id: string, userSub: string): Promise<boolean> {
    const { count } = await this.prisma.conversation.deleteMany({ where: { id, userSub } });
    return count > 0;
  }

  /** Ownership is part of the lookup — a foreign conversation is "not found". */
  async getConversation(id: string, userSub: string): Promise<Conversation | null> {
    const conversation = await this.prisma.conversation.findFirst({ where: { id, userSub } });
    return conversation ? toConversation(conversation) : null;
  }

  /** The active chain, oldest first — exactly what is sent to the LLM. */
  async listActiveMessages(conversationId: string): Promise<MessageRecord[]> {
    const rows = await this.prisma.$queryRaw<(MessageRow & { file_ids: string[] })[]>`
      SELECT m.id, m.conversation_id, m.role, m.content, m.seq, m.active,
             m.parent_message_id, m.created_at,
             COALESCE(
               array_agg(mf.file_id) FILTER (WHERE mf.file_id IS NOT NULL),
               '{}'
             ) AS file_ids
        FROM messages m
        LEFT JOIN message_files mf ON mf.message_id = m.id
       WHERE m.conversation_id = ${conversationId}::uuid AND m.active
       GROUP BY m.id
       ORDER BY m.seq`;
    return rows.map((row) => ({ ...toMessage(row), fileIds: row.file_ids }));
  }

  /**
   * Appends with a per-conversation seq. The conversation row is locked for
   * the transaction, serializing concurrent sends within one conversation.
   */
  async appendMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    parentMessageId: string | null = null,
    fileIds: string[] = [],
  ): Promise<MessageRecord> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
      const rows = await tx.$queryRaw<MessageRow[]>`
        INSERT INTO messages (conversation_id, role, content, seq, parent_message_id)
        SELECT ${conversationId}::uuid, ${role}::"MessageRole", ${content},
               COALESCE(MAX(seq), 0) + 1, ${parentMessageId}::uuid
          FROM messages WHERE conversation_id = ${conversationId}::uuid
        RETURNING ${Prisma.raw(MESSAGE_COLUMNS)}`;
      for (const fileId of fileIds) {
        await tx.$executeRaw`INSERT INTO message_files (message_id, file_id)
          VALUES (${rows[0].id}::uuid, ${fileId}::uuid)`;
      }
      await tx.$executeRaw`UPDATE conversations SET updated_at = now() WHERE id = ${conversationId}::uuid`;
      return { ...toMessage(rows[0]), fileIds };
    });
  }

  /**
   * Edit-and-regenerate, linearly (see DECISIONS.md, slice 9): the target
   * user message and everything after it are soft-superseded (active=false,
   * kept for audit/v2 branching), and the edited content is appended as a
   * NEW row whose parent_message_id points at the original — the version
   * link. Returns null when the target is not an active user message of
   * this conversation.
   */
  async supersedeAndReplace(
    conversationId: string,
    messageId: string,
    content: string,
  ): Promise<MessageRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM conversations WHERE id = ${conversationId}::uuid FOR UPDATE`;
      const target = await tx.$queryRaw<{ seq: number }[]>`
        SELECT seq FROM messages
         WHERE id = ${messageId}::uuid AND conversation_id = ${conversationId}::uuid
           AND role = 'user' AND active`;
      if (target.length === 0) {
        return null;
      }
      await tx.$executeRaw`
        UPDATE messages SET active = false
         WHERE conversation_id = ${conversationId}::uuid AND seq >= ${target[0].seq} AND active`;
      const rows = await tx.$queryRaw<MessageRow[]>`
        INSERT INTO messages (conversation_id, role, content, seq, parent_message_id)
        SELECT ${conversationId}::uuid, 'user'::"MessageRole", ${content},
               COALESCE(MAX(seq), 0) + 1, ${messageId}::uuid
          FROM messages WHERE conversation_id = ${conversationId}::uuid
        RETURNING ${Prisma.raw(MESSAGE_COLUMNS)}`;
      await tx.$executeRaw`UPDATE conversations SET updated_at = now() WHERE id = ${conversationId}::uuid`;
      return toMessage(rows[0]);
    });
  }
}

function toConversation(row: {
  id: string;
  userSub: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
}): Conversation {
  return {
    id: row.id,
    userSub: row.userSub,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    seq: row.seq,
    active: row.active,
    parentMessageId: row.parent_message_id,
    fileIds: [],
    createdAt: row.created_at,
  };
}
