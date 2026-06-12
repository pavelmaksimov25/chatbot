import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { readSse } from './sse';

interface ChatMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  /** Attachment count from history; names known only for local sends. */
  attachments?: string[];
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
  const [attachment, setAttachment] = useState<{ id: string; name: string } | null>(null);
  const [attaching, setAttaching] = useState(false);
  const activeRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const setStreamingState = useCallback((value: boolean): void => {
    streamingRef.current = value;
    setStreaming(value);
  }, []);

  const refreshList = useCallback(async (): Promise<ConversationItem[]> => {
    const res = await fetch('/conversations').catch(() => null);
    if (!res?.ok) {
      return [];
    }
    const list = (await res.json()) as ConversationItem[];
    setConversations(list);
    return list;
  }, []);

  const appendToAnswer = useCallback((text: string): void => {
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, content: last.content + text };
      return next;
    });
  }, []);

  const dropEmptyAnswer = useCallback((): void => {
    setMessages((prev) =>
      prev.at(-1)?.role === 'assistant' && prev.at(-1)?.content === '' ? prev.slice(0, -1) : prev,
    );
  }, []);

  /** Reads an SSE answer stream into the trailing assistant message. */
  const consumeStream = useCallback(
    async (res: Response): Promise<void> => {
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
    },
    [appendToAnswer],
  );

  const createConversation = useCallback(async (): Promise<string> => {
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
    return id;
  }, [csrfToken]);

  /** New chat = fresh conversation greeted by the assistant before any input. */
  const startWelcomeChat = useCallback(async (): Promise<void> => {
    activeRef.current = null;
    setActiveId(null);
    setEditing(null);
    setInput('');
    setError(null);
    setStreamingState(true);
    setMessages([{ role: 'assistant', content: '' }]);
    try {
      const id = await createConversation();
      const res = await fetch(`/conversations/${encodeURIComponent(id)}/welcome`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
      });
      await consumeStream(res);
      void refreshList();
    } catch (err) {
      dropEmptyAnswer();
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setStreamingState(false);
    }
  }, [createConversation, consumeStream, csrfToken, dropEmptyAnswer, refreshList]);

  const openConversation = useCallback(async (id: string): Promise<void> => {
    activeRef.current = id;
    setActiveId(id);
    localStorage.setItem(CONVERSATION_KEY, id);
    setError(null);
    const res = await fetch(`/conversations/${encodeURIComponent(id)}/messages`).catch(() => null);
    if (res?.status === 404) {
      // Deleted elsewhere; fall back to a blank state.
      clearView();
      return;
    }
    if (res?.ok) {
      const history = (await res.json()) as ChatMessage[];
      // Ignore the response if the user switched again while it loaded or
      // a stream is writing into the view (stale history must not clobber it).
      if (activeRef.current === id && !streamingRef.current) {
        setMessages(
          history.map((m: ChatMessage & { fileIds?: string[] }) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            attachments: m.fileIds?.map(() => 'attachment'),
          })),
        );
      }
    }
  }, []);

  const clearView = (): void => {
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

  // A reload resumes the last open conversation; a first visit with no
  // history starts a welcomed conversation straight away.
  useEffect(() => {
    void refreshList().then((list) => {
      const stored = localStorage.getItem(CONVERSATION_KEY);
      if (stored && list.some((c) => c.id === stored)) {
        void openConversation(stored);
      } else if (stored && stored !== activeRef.current) {
        // Stale id from a conversation deleted elsewhere — but never clear an
        // id a concurrent send just created (the list fetch predates it).
        localStorage.removeItem(CONVERSATION_KEY);
      } else if (!stored && list.length === 0) {
        void startWelcomeChat();
      }
    });
  }, [refreshList, openConversation, startWelcomeChat]);

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
      clearView();
    }
  };

  const attachFile = async (file: File): Promise<void> => {
    setAttaching(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch('/files', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? 'the file could not be attached');
      }
      const uploaded = (await res.json()) as { id: string; name: string };
      setAttachment({ id: uploaded.id, name: uploaded.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the file could not be attached');
    } finally {
      setAttaching(false);
      if (attachInputRef.current) {
        attachInputRef.current.value = '';
      }
    }
  };

  const send = async (): Promise<void> => {
    const content = input.trim();
    if (!content || streaming) {
      return;
    }
    const editTarget = editing;
    const attached = attachment;
    setError(null);
    setStreamingState(true);
    setInput('');
    setEditing(null);
    setAttachment(null);
    setMessages((prev) => {
      // An edit truncates the tail locally — the server soft-supersedes it.
      const base = editTarget
        ? prev.slice(
            0,
            prev.findIndex((m) => m.id === editTarget.id),
          )
        : prev;
      return [
        ...base,
        { role: 'user', content, attachments: attached ? [attached.name] : undefined },
        { role: 'assistant', content: '' },
      ];
    });

    try {
      if (!activeRef.current) {
        await createConversation();
      }
      const conversation = encodeURIComponent(activeRef.current!);
      const url = editTarget
        ? `/conversations/${conversation}/messages/${encodeURIComponent(editTarget.id)}/edit`
        : `/conversations/${conversation}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ content, ...(attached && { fileIds: [attached.id] }) }),
      });
      await consumeStream(res);
      void refreshList(); // ordering + preview may have changed
    } catch (err) {
      dropEmptyAnswer();
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setStreamingState(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '2rem', alignItems: 'flex-start' }}>
      <nav aria-label="Conversations">
        <button onClick={() => void startWelcomeChat()} disabled={streaming}>
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
                  {message.content}
                  {message.attachments?.map((name, j) => (
                    <span key={j}> 📎 {name}</span>
                  ))}{' '}
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
          <label>
            Attach{' '}
            <input
              ref={attachInputRef}
              type="file"
              accept=".txt,.md,.json,.pdf,image/*,text/*"
              disabled={streaming || attaching}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void attachFile(file);
                }
              }}
            />
          </label>{' '}
          {attachment && (
            <span>
              📎 {attachment.name}{' '}
              <button type="button" onClick={() => setAttachment(null)}>
                Remove
              </button>
            </span>
          )}{' '}
          <button type="submit" disabled={streaming || attaching || input.trim().length === 0}>
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
