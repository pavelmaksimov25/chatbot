import type { ConversationItem, Suggestions } from './types';

const CONVERSATIONS = '/conversations';

function withCsrf(token: string, extra?: HeadersInit): HeadersInit {
  return { 'X-CSRF-Token': token, ...extra };
}

/** GET the conversation list; null if the request fails. */
export async function fetchConversations(): Promise<ConversationItem[] | null> {
  const res = await fetch(CONVERSATIONS).catch(() => null);
  return res?.ok ? ((await res.json()) as ConversationItem[]) : null;
}

export async function createConversation(csrfToken: string): Promise<string> {
  const res = await fetch(CONVERSATIONS, { method: 'POST', headers: withCsrf(csrfToken) });
  if (!res.ok) {
    throw new Error('could not start a conversation');
  }
  return ((await res.json()) as { id: string }).id;
}

/** Streams the pre-input greeting; caller consumes the SSE body. */
export function postWelcome(id: string, csrfToken: string): Promise<Response> {
  return fetch(`${CONVERSATIONS}/${encodeURIComponent(id)}/welcome`, {
    method: 'POST',
    headers: withCsrf(csrfToken),
  });
}

/** GET stored history. Raw response so callers can branch on 404 vs ok. */
export function fetchHistory(id: string): Promise<Response | null> {
  return fetch(`${CONVERSATIONS}/${encodeURIComponent(id)}/messages`).catch(() => null);
}

/** POSTs a new turn (or an edit); caller consumes the streamed SSE body. */
export function postMessage(
  id: string,
  body: { content: string; fileIds?: string[] },
  csrfToken: string,
  editMessageId?: string,
): Promise<Response> {
  const base = `${CONVERSATIONS}/${encodeURIComponent(id)}/messages`;
  const url = editMessageId ? `${base}/${encodeURIComponent(editMessageId)}/edit` : base;
  return fetch(url, {
    method: 'POST',
    headers: withCsrf(csrfToken, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

/** True on the expected 204; false on any other outcome. */
export async function deleteConversation(id: string, csrfToken: string): Promise<boolean> {
  const res = await fetch(`${CONVERSATIONS}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: withCsrf(csrfToken),
  }).catch(() => null);
  return res?.status === 204;
}

export async function uploadFile(
  file: File,
  csrfToken: string,
): Promise<{ id: string; name: string }> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('/files', { method: 'POST', headers: withCsrf(csrfToken), body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? 'the file could not be attached');
  }
  return (await res.json()) as { id: string; name: string };
}

export async function fetchSuggestions(id: string): Promise<Suggestions | null> {
  const res = await fetch(`${CONVERSATIONS}/${encodeURIComponent(id)}/suggestions`).catch(
    () => null,
  );
  return res?.ok ? ((await res.json()) as Suggestions) : null;
}
