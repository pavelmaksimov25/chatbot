import { useCallback, useEffect, useRef, useState } from 'react';
import { readSse } from '../sse';
import * as api from './api';
import type { ChatMessage, ConversationItem } from './types';

const CONVERSATION_KEY = 'conversationId';

export function useChat(csrfToken: string) {
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string } | null>(null);
  const [attachment, setAttachment] = useState<{ id: string; name: string } | null>(null);
  const [chips, setChips] = useState<string[]>([]);
  const [attaching, setAttaching] = useState(false);
  const activeRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  const attachInputRef = useRef<HTMLInputElement>(null);

  const setStreamingState = useCallback((value: boolean): void => {
    streamingRef.current = value;
    setStreaming(value);
  }, []);

  const refreshList = useCallback(async (): Promise<ConversationItem[]> => {
    const list = await api.fetchConversations();
    if (list) {
      setConversations(list);
    }
    return list ?? [];
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
    async (res: Response): Promise<string | null> => {
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? 'the message could not be sent');
      }
      let doneAssistantId: string | null = null;
      for await (const { event, data } of readSse(res.body)) {
        if (event === 'chunk' && typeof data.text === 'string') {
          appendToAnswer(data.text);
        } else if (event === 'done') {
          // Adopt the persisted ids so the new turn is editable in place.
          const userMessageId = data.userMessageId;
          const assistantMessageId = data.assistantMessageId;
          if (typeof assistantMessageId === 'string') {
            doneAssistantId = assistantMessageId;
          }
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
      return doneAssistantId;
    },
    [appendToAnswer],
  );

  /** Chips arrive a beat after the answer — poll briefly, then give up quietly. */
  const pollChips = useCallback(
    async (conversationId: string, assistantId: string | null) => {
      if (!assistantId) {
        return;
      }
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const loadChipsWaitTime = 1500;
        await new Promise((resolve) => setTimeout(resolve, loadChipsWaitTime));
        if (activeRef.current !== conversationId) {
          return; // user moved on
        }
        const body = await api.fetchSuggestions(conversationId);
        if (body && body.forMessageId === assistantId && body.suggestions.length > 0) {
          setChips(body.suggestions);
          void refreshList(); // the async title has likely landed too
          return;
        }
      }
    },
    [refreshList],
  );

  const createConversation = useCallback(async (): Promise<string> => {
    const id = await api.createConversation(csrfToken);
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
    setChips([]);
    setStreamingState(true);
    setMessages([{ role: 'assistant', content: '' }]);
    try {
      const id = await createConversation();
      const res = await api.postWelcome(id, csrfToken);
      const assistantId = await consumeStream(res);
      void refreshList();
      void pollChips(id, assistantId);
    } catch (err) {
      dropEmptyAnswer();
      setError(err instanceof Error ? err.message : 'something went wrong');
    } finally {
      setStreamingState(false);
    }
  }, [
    createConversation,
    consumeStream,
    csrfToken,
    dropEmptyAnswer,
    refreshList,
    pollChips,
    setStreamingState,
  ]);

  const clearView = useCallback((): void => {
    activeRef.current = null;
    setActiveId(null);
    setMessages([]);
    setError(null);
    setEditing(null);
    setInput('');
    setChips([]);
    localStorage.removeItem(CONVERSATION_KEY);
  }, []);

  const openConversation = useCallback(
    async (id: string): Promise<void> => {
      activeRef.current = id;
      setActiveId(id);
      localStorage.setItem(CONVERSATION_KEY, id);
      setError(null);
      setChips([]);
      const res = await api.fetchHistory(id);
      if (res?.status === 404) {
        // Deleted elsewhere; fall back to a blank state.
        clearView();
        return;
      }
      if (res?.ok) {
        const history = (await res.json()) as (ChatMessage & { fileIds?: string[] })[];
        // Ignore the response if the user switched again while it loaded or
        // a stream is writing into the view (stale history must not clobber it).
        if (activeRef.current === id && !streamingRef.current) {
          setMessages(
            history.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              attachments: m.fileIds?.map(() => 'attachment'),
            })),
          );
        }
      }
    },
    [clearView],
  );

  const startEditing = useCallback(
    (message: ChatMessage): void => {
      if (!message.id || streaming) {
        return;
      }
      setEditing({ id: message.id });
      setInput(message.content);
    },
    [streaming],
  );

  const cancelEditing = useCallback((): void => {
    setEditing(null);
    setInput('');
  }, []);

  const clearAttachment = useCallback((): void => {
    setAttachment(null);
  }, []);

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

  const removeConversation = useCallback(
    async (id: string): Promise<void> => {
      const ok = await api.deleteConversation(id, csrfToken);
      if (!ok) {
        setError('the conversation could not be deleted');
        return;
      }
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeRef.current === id) {
        clearView();
      }
    },
    [csrfToken, clearView],
  );

  const attachFile = useCallback(
    async (file: File): Promise<void> => {
      setAttaching(true);
      setError(null);
      try {
        const uploaded = await api.uploadFile(file, csrfToken);
        setAttachment({ id: uploaded.id, name: uploaded.name });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'the file could not be attached');
      } finally {
        setAttaching(false);
        if (attachInputRef.current) {
          attachInputRef.current.value = '';
        }
      }
    },
    [csrfToken],
  );

  const send = useCallback(
    async (contentOverride?: string): Promise<void> => {
      const content = (contentOverride ?? input).trim();
      if (!content || streaming) {
        return;
      }
      const editTarget = editing;
      const attached = attachment;
      setError(null);
      setChips([]);
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
        const res = await api.postMessage(
          activeRef.current!,
          { content, ...(attached && { fileIds: [attached.id] }) },
          csrfToken,
          editTarget?.id,
        );
        const assistantId = await consumeStream(res);
        void refreshList(); // ordering + preview may have changed
        void pollChips(activeRef.current!, assistantId);
      } catch (err) {
        dropEmptyAnswer();
        setError(err instanceof Error ? err.message : 'something went wrong');
      } finally {
        setStreamingState(false);
      }
    },
    [
      input,
      streaming,
      editing,
      attachment,
      setStreamingState,
      createConversation,
      csrfToken,
      consumeStream,
      refreshList,
      pollChips,
      dropEmptyAnswer,
    ],
  );

  return {
    conversations,
    messages,
    input,
    streaming,
    error,
    activeId,
    editing,
    attachment,
    chips,
    attaching,
    attachInputRef,
    setInput,
    startWelcomeChat,
    openConversation,
    removeConversation,
    startEditing,
    cancelEditing,
    attachFile,
    clearAttachment,
    send,
  };
}
