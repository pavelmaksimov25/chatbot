import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chat } from './Chat';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface StubOptions {
  frames?: string[];
  list?: { id: string; title: string | null; preview: string | null }[];
  history?: Record<string, { role: string; content: string }[]>;
}

function stubChatFetch(options: StubOptions = {}): ReturnType<typeof vi.fn> {
  const { frames = [], list = [], history = {} } = options;
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/conversations' && method === 'POST') {
      return Promise.resolve(Response.json({ id: 'conv-1' }, { status: 201 }));
    }
    if (url === '/conversations' && method === 'GET') {
      return Promise.resolve(Response.json(list));
    }
    if (method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const messages = /^\/conversations\/([^/]+)\/messages$/.exec(url);
    if (messages && method === 'POST') {
      return Promise.resolve(sseResponse(frames));
    }
    if (messages && method === 'GET') {
      return Promise.resolve(Response.json(history[decodeURIComponent(messages[1])] ?? []));
    }
    return Promise.resolve(new Response('', { status: 404 }));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function sendMessage(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(/Message/), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('button', { name: 'Send' }); // streaming finished
}

describe('Chat', () => {
  it('sends a message and renders the streamed answer as markdown', async () => {
    const mock = stubChatFetch({
      frames: [
        'event: chunk\ndata: {"text":"Here is **bold"}\n\n',
        'event: chunk\ndata: {"text":"** text"}\n\n',
        'event: done\ndata: {"conversationId":"conv-1"}\n\n',
      ],
    });
    render(<Chat csrfToken="token" />);

    await sendMessage('hello');

    expect(screen.getByText('hello')).toBeDefined();
    const bold = await screen.findByText('bold');
    expect(bold.tagName).toBe('STRONG');
    expect(localStorage.getItem('conversationId')).toBe('conv-1');

    const send = mock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/messages') && init?.method === 'POST',
    );
    expect(send![1]?.headers).toMatchObject({ 'X-CSRF-Token': 'token' });
  });

  it('never renders model output as raw HTML', async () => {
    stubChatFetch({
      frames: [
        'event: chunk\ndata: {"text":"<img src=x onerror=alert(1)> stays text"}\n\n',
        'event: done\ndata: {}\n\n',
      ],
    });
    const { container } = render(<Chat csrfToken="token" />);

    await sendMessage('inject');

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('stays text');
  });

  it('surfaces a mid-stream error without losing the conversation', async () => {
    stubChatFetch({
      frames: [
        'event: chunk\ndata: {"text":"partial"}\n\n',
        'event: error\ndata: {"message":"the answer was interrupted, try again"}\n\n',
      ],
    });
    render(<Chat csrfToken="token" />);

    await sendMessage('doomed');

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('doomed')).toBeDefined(); // user message kept
  });

  it('lists conversations in the sidebar and opens one on click', async () => {
    stubChatFetch({
      list: [
        { id: 'conv-2', title: null, preview: 'about valkey' },
        { id: 'conv-1', title: null, preview: 'about kubernetes' },
      ],
      history: {
        'conv-1': [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
      },
    });
    render(<Chat csrfToken="token" />);

    fireEvent.click(await screen.findByRole('button', { name: 'about kubernetes' }));

    expect(await screen.findByText('earlier question')).toBeDefined();
    expect(await screen.findByText('earlier answer')).toBeDefined();
    expect(localStorage.getItem('conversationId')).toBe('conv-1');
  });

  it('resumes the stored conversation on mount when it still exists', async () => {
    localStorage.setItem('conversationId', 'conv-1');
    stubChatFetch({
      list: [{ id: 'conv-1', title: null, preview: 'resumed' }],
      history: { 'conv-1': [{ role: 'assistant', content: 'welcome back' }] },
    });
    render(<Chat csrfToken="token" />);

    expect(await screen.findByText('welcome back')).toBeDefined();
  });

  it('deletes a conversation with the CSRF token and clears the view', async () => {
    localStorage.setItem('conversationId', 'conv-1');
    const mock = stubChatFetch({
      list: [{ id: 'conv-1', title: null, preview: 'doomed convo' }],
      history: { 'conv-1': [{ role: 'assistant', content: 'soon gone' }] },
    });
    render(<Chat csrfToken="token" />);
    await screen.findByText('soon gone');

    fireEvent.click(screen.getByRole('button', { name: /Delete conversation doomed convo/ }));

    await waitFor(() => expect(screen.queryByText('soon gone')).toBeNull());
    expect(screen.queryByRole('button', { name: 'doomed convo' })).toBeNull();
    expect(localStorage.getItem('conversationId')).toBeNull();
    const del = mock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(String(del![0])).toBe('/conversations/conv-1');
    expect(del![1]?.headers).toMatchObject({ 'X-CSRF-Token': 'token' });
  });

  it('starts a fresh chat via New chat', async () => {
    localStorage.setItem('conversationId', 'conv-1');
    stubChatFetch({
      list: [{ id: 'conv-1', title: null, preview: 'old one' }],
      history: { 'conv-1': [{ role: 'assistant', content: 'old message' }] },
    });
    render(<Chat csrfToken="token" />);
    await screen.findByText('old message');

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    expect(screen.queryByText('old message')).toBeNull();
    expect(localStorage.getItem('conversationId')).toBeNull();
  });
});
