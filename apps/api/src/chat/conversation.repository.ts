import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../db/db.module';

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

interface ConversationRow {
  id: string;
  user_sub: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
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
export class ConversationRepository implements OnModuleInit {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // Tracer-bullet migration: idempotent DDL on boot, like user-service.
  async onModuleInit(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_sub   text NOT NULL,
        title      text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS conversations_user_idx
        ON conversations (user_sub, updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role              text NOT NULL CHECK (role IN ('user', 'assistant')),
        content           text NOT NULL,
        seq               integer NOT NULL,
        active            boolean NOT NULL DEFAULT true,
        -- Seam for v2 branching/versioned edits; written, not yet queried.
        parent_message_id uuid REFERENCES messages(id),
        created_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (conversation_id, seq)
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_idx
        ON messages (conversation_id, seq);
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS flagged boolean NOT NULL DEFAULT false;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS flag_reason text;
      CREATE TABLE IF NOT EXISTS message_files (
        message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        -- No FK to files: the files table is owned by another module whose
        -- DDL may run later; a deleted file degrades to a placeholder part.
        file_id    uuid NOT NULL,
        PRIMARY KEY (message_id, file_id)
      );
    `);
  }

  async createConversation(userSub: string): Promise<Conversation> {
    const { rows } = await this.pool.query<ConversationRow>(
      `INSERT INTO conversations (user_sub) VALUES ($1)
       RETURNING id, user_sub, title, created_at, updated_at`,
      [userSub],
    );
    return toConversation(rows[0]);
  }

  /** Most recently touched first; previews come from the first active user message. */
  async listConversations(userSub: string): Promise<ConversationListItem[]> {
    const { rows } = await this.pool.query<{
      id: string;
      title: string | null;
      preview: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT left(m.content, 80) FROM messages m
                WHERE m.conversation_id = c.id AND m.role = 'user' AND m.active
                ORDER BY m.seq LIMIT 1) AS preview
         FROM conversations c
        WHERE c.user_sub = $1
        ORDER BY c.updated_at DESC`,
      [userSub],
    );
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      preview: row.preview,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Hard delete; messages go with it (FK CASCADE). Foreign = not found. */
  async deleteConversation(id: string, userSub: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM conversations WHERE id = $1 AND user_sub = $2',
      [id, userSub],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Ownership is part of the lookup — a foreign conversation is "not found". */
  async getConversation(id: string, userSub: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query<ConversationRow>(
      `SELECT id, user_sub, title, created_at, updated_at
         FROM conversations WHERE id = $1 AND user_sub = $2`,
      [id, userSub],
    );
    return rows[0] ? toConversation(rows[0]) : null;
  }

  /** The active chain, oldest first — exactly what is sent to the LLM. */
  async listActiveMessages(conversationId: string): Promise<MessageRecord[]> {
    const { rows } = await this.pool.query<MessageRow & { file_ids: string[] }>(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.seq, m.active,
              m.parent_message_id, m.created_at,
              COALESCE(
                array_agg(mf.file_id) FILTER (WHERE mf.file_id IS NOT NULL),
                '{}'
              ) AS file_ids
         FROM messages m
         LEFT JOIN message_files mf ON mf.message_id = m.id
        WHERE m.conversation_id = $1 AND m.active
        GROUP BY m.id
        ORDER BY m.seq`,
      [conversationId],
    );
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
    return this.inTransaction(async (tx) => {
      await tx.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
      const { rows } = await tx.query<MessageRow>(
        `INSERT INTO messages (conversation_id, role, content, seq, parent_message_id)
         SELECT $1, $2, $3, COALESCE(MAX(seq), 0) + 1, $4 FROM messages WHERE conversation_id = $1
         RETURNING ${MESSAGE_COLUMNS}`,
        [conversationId, role, content, parentMessageId],
      );
      for (const fileId of fileIds) {
        await tx.query('INSERT INTO message_files (message_id, file_id) VALUES ($1, $2)', [
          rows[0].id,
          fileId,
        ]);
      }
      await tx.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
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
    return this.inTransaction(async (tx) => {
      await tx.query('SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE', [conversationId]);
      const target = await tx.query<{ seq: number }>(
        `SELECT seq FROM messages
          WHERE id = $1 AND conversation_id = $2 AND role = 'user' AND active`,
        [messageId, conversationId],
      );
      if (target.rows.length === 0) {
        return null;
      }
      await tx.query(
        'UPDATE messages SET active = false WHERE conversation_id = $1 AND seq >= $2 AND active',
        [conversationId, target.rows[0].seq],
      );
      const { rows } = await tx.query<MessageRow>(
        `INSERT INTO messages (conversation_id, role, content, seq, parent_message_id)
         SELECT $1, 'user', $2, COALESCE(MAX(seq), 0) + 1, $3 FROM messages WHERE conversation_id = $1
         RETURNING ${MESSAGE_COLUMNS}`,
        [conversationId, content, messageId],
      );
      await tx.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
      return toMessage(rows[0]);
    });
  }

  private async inTransaction<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userSub: row.user_sub,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
