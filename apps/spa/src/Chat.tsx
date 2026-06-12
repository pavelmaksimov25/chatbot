import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { readSse } from './sse';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const CONVERSATION_KEY = 'conversationId';

export function Chat({ csrfToken }: { csrfToken: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationRef = useRef<string | null>(localStorage.getItem(CONVERSATION_KEY));

  // A reload resumes the conversation whose id we kept (a non-secret UUID).
  useEffect(() => {
    const conversationId = conversationRef.current;
    if (!conversationId) {
      return;
    }
    let cancelled = false;
    void fetch(`/conversations/${encodeURIComponent(conversationId)}/messages`)
      .then(async (res) => {
        if (res.status === 404) {
          conversationRef.current = null;
          localStorage.removeItem(CONVERSATION_KEY);
          return null;
        }
        return res.ok ? ((await res.json()) as ChatMessage[]) : null;
      })
      .catch(() => null)
      .then((history) => {
        if (!cancelled && history) {
          setMessages(history.map(({ role, content }) => ({ role, content })));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const send = async (): Promise<void> => {
    const content = input.trim();
    if (!content || streaming) {
      return;
    }
    setError(null);
    setStreaming(true);
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content }, { role: 'assistant', content: '' }]);

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
      if (!conversationRef.current) {
        const created = await fetch('/conversations', {
          method: 'POST',
          headers: { 'X-CSRF-Token': csrfToken },
        });
        if (!created.ok) {
          throw new Error('could not start a conversation');
        }
        conversationRef.current = ((await created.json()) as { id: string }).id;
        localStorage.setItem(CONVERSATION_KEY, conversationRef.current);
      }

      const res = await fetch(
        `/conversations/${encodeURIComponent(conversationRef.current)}/messages`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ content }),
        },
      );
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? 'the message could not be sent');
      }

      for await (const { event, data } of readSse(res.body)) {
        if (event === 'chunk' && typeof data.text === 'string') {
          appendToAnswer(data.text);
        } else if (event === 'error') {
          throw new Error(typeof data.message === 'string' ? data.message : 'stream failed');
        }
      }
    } catch (err) {
      dropEmptyAnswer();
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setStreaming(false);
    }
  };

  return (
    <section aria-label="Chat">
      <ol>
        {messages.map((message, i) => (
          <li key={i} data-role={message.role}>
            {message.role === 'assistant' ? (
              // react-markdown renders to React elements — model output is
              // never injected as raw HTML (CSP is the second net).
              <Markdown>{message.content}</Markdown>
            ) : (
              <p>{message.content}</p>
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
          {streaming ? 'Answering…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
