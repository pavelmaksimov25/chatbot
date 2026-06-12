import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { readSse } from './sse';

interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationItem {
  id: string;
  title: string | null;
  preview: string | null;
}

const CONVERSATION_KEY = 'conversationId';

export function Chat({ csrfToken }: { csrfToken: string }) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string } | null>(null);
  const activeRef = useRef<string | null>(null);

  const refreshList = useCallback(async (): Promise<ConversationItem[]> => {
    const res = await fetch('/conversations').catch(() => null);
    if (!res?.ok) {
      return [];
    }
    const list = (await res.json()) as ConversationItem[];
    setConversations(list);
    return list;
  }, []);

  const openConversation = useCallback(async (id: string): Promise<void> => {
    activeRef.current = id;
    setActiveId(id);
    localStorage.setItem(CONVERSATION_KEY, id);
    setError(null);
    const res = await fetch(`/conversations/${encodeURIComponent(id)}/messages`).catch(() => null);
    if (res?.status === 404) {
      // Deleted elsewhere; fall back to a fresh chat.
      startNewChat();
      return;
    }
    if (res?.ok) {
      const history = (await res.json()) as ChatMessage[];
      // Ignore the response if the user switched again while it loaded.
      if (activeRef.current === id) {
        setMessages(
          history.map(({ id: messageId, role, content }) => ({ id: messageId, role, content })),
        );
      }
    }
  }, []);

  const startNewChat = (): void => {
    activeRef.current = null;
    setActiveId(null);
    setMessages([]);
    setError(null);
    setEditing(null);
    setInput('');
    localStorage.removeItem(CONVERSATION_KEY);
  };

  const startEditing = (message: ChatMessage): void => {
    if (!message.id || streaming) {
      return;
    }
    setEditing({ id: message.id });
    setInput(message.content);
  };

  const cancelEditing = (): void => {
    setEditing(null);
    setInput('');
  };

  // A reload resumes the last open conversation (a non-secret UUID).
  useEffect(() => {
    void refreshList().then((list) => {
      const stored = localStorage.getItem(CONVERSATION_KEY);
      if (stored && list.some((c) => c.id === stored)) {
        void openConversation(stored);
      } else if (stored && stored !== activeRef.current) {
        // Stale id from a conversation deleted elsewhere — but never clear an
        // id a concurrent send just created (the list fetch predates it).
        localStorage.removeItem(CONVERSATION_KEY);
      }
    });
  }, [refreshList, openConversation]);

  const removeConversation = async (id: string): Promise<void> => {
    const res = await fetch(`/conversations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken },
    }).catch(() => null);
    if (res?.status !== 204) {
      setError('the conversation could not be deleted');
      return;
    }
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeRef.current === id) {
      startNewChat();
    }
  };

  const send = async (): Promise<void> => {
    const content = input.trim();
    if (!content || streaming) {
      return;
    }
    const editTarget = editing;
    setError(null);
    setStreaming(true);
    setInput('');
    setEditing(null);
    setMessages((prev) => {
      // An edit truncates the tail locally — the server soft-supersedes it.
      const base = editTarget
        ? prev.slice(
            0,
            prev.findIndex((m) => m.id === editTarget.id),
          )
        : prev;
      return [...base, { role: 'user', content }, { role: 'assistant', content: '' }];
    });

    const appendToAnswer = (text: string): void =>
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, content: last.content + text };
        return next;
      });
    const dropEmptyAnswer = (): void =>
      setMessages((prev) =>
        prev.at(-1)?.role === 'assistant' && prev.at(-1)?.content === '' ? prev.slice(0, -1) : prev,
      );

    try {
      if (!activeRef.current) {
        const created = await fetch('/conversations', {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrfToken },
        });
        if (!created.ok) {
          throw new Error('could not start a conversation');
        }
        const id = ((await created.json()) as { id: string }).id;
        activeRef.current = id;
        setActiveId(id);
        localStorage.setItem(CONVERSATION_KEY, id);
      }

      const conversation = encodeURIComponent(activeRef.current);
      const url = editTarget
        ? `/conversations/${conversation}/messages/${encodeURIComponent(editTarget.id)}/edit`
        : `/conversations/${conversation}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ content }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? 'the message could not be sent');
      }

      for await (const { event, data } of readSse(res.body)) {
        if (event === 'chunk' && typeof data.text === 'string') {
          appendToAnswer(data.text);
        } else if (event === 'done') {
          // Adopt the persisted ids so the new turn is editable in place.
          const userMessageId = data.userMessageId;
          const assistantMessageId = data.assistantMessageId;
          setMessages((prev) => {
            const next = [...prev];
            const user = next.at(-2);
            const assistant = next.at(-1);
            if (user?.role === 'user' && typeof userMessageId === 'string') {
              next[next.length - 2] = { ...user, id: userMessageId };
            }
            if (assistant?.role === 'assistant' && typeof assistantMessageId === 'string') {
              next[next.length - 1] = { ...assistant, id: assistantMessageId };
            }
            return next;
          });
        } else if (event === 'error') {
          throw new Error(typeof data.message === 'string' ? data.message : 'stream failed');
        }
      }
      void refreshList(); // ordering + preview may have changed
    } catch (err) {
      dropEmptyAnswer();
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setStreaming(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>
      <nav aria-label="Conversations">
        <button onClick={startNewChat} disabled={streaming}>
          New chat
        </button>
        <ul>
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <button
                onClick={() => void openConversation(conversation.id)}
                disabled={streaming}
                aria-current={conversation.id === activeId ? 'true' : undefined}
              >
                {conversation.title ?? conversation.preview ?? 'New conversation'}
              </button>{' '}
              <button
                aria-label={`Delete conversation ${conversation.title ?? conversation.preview ?? conversation.id}`}
                onClick={() => void removeConversation(conversation.id)}
                disabled={streaming}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section aria-label="Chat" style={{ flex: 1 }}>
        <ol>
          {messages.map((message, i) => (
            <li key={message.id ?? i} data-role={message.role}>
              {message.role === 'assistant' ? (
                // react-markdown renders to React elements — model output is
                // never injected as raw HTML (CSP is the second net).
                <Markdown>{message.content}</Markdown>
              ) : (
                <p>
                  {message.content}{' '}
                  {message.id && (
                    <button
                      aria-label={`Edit message ${message.content.slice(0, 40)}`}
                      onClick={() => startEditing(message)}
                      disabled={streaming}
                    >
                      Edit
                    </button>
                  )}
                </p>
              )}
            </li>
          ))}
        </ol>
        {error && <p role="alert">{error}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label>
            Message{' '}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
              maxLength={8000}
            />
          </label>{' '}
          <button type="submit" disabled={streaming || input.trim().length === 0}>
            {streaming ? 'Answering…' : editing ? 'Save edit' : 'Send'}
          </button>
          {editing && (
            <button type="button" onClick={cancelEditing}>
              Cancel edit
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
