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
  welcomeFrames?: string[];
  list?: { id: string; title: string | null; preview: string | null }[];
  history?: Record<string, { id?: string; role: string; content: string }[]>;
  suggestions?: { forMessageId: string | null; suggestions: string[] };
}

function stubChatFetch(options: StubOptions = {}): ReturnType<typeof vi.fn> {
  const {
    frames = [],
    welcomeFrames = ['event: done\ndata: {"assistantMessageId":"w1"}\n\n'],
    list = [],
    history = {},
    suggestions = { forMessageId: null, suggestions: [] },
  } = options;
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
    if (/^\/conversations\/[^/]+\/welcome$/.test(url) && method === 'POST') {
      return Promise.resolve(sseResponse(welcomeFrames));
    }
    if (url === '/files' && method === 'POST') {
      return Promise.resolve(Response.json({ id: 'file-9', name: 'shot.png' }, { status: 201 }));
    }
    if (/\/suggestions$/.test(url)) {
      return Promise.resolve(Response.json(suggestions));
    }
    const messages = /^\/conversations\/([^/]+)\/messages(?:\/[^/]+\/edit)?$/.exec(url);
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

/** Mount in a resumed conversation so the auto-welcome path stays quiet. */
function resumedStub(options: StubOptions = {}): ReturnType<typeof vi.fn> {
  localStorage.setItem('conversationId', 'conv-1');
  return stubChatFetch({
    list: [{ id: 'conv-1', title: null, preview: 'resumed' }],
    history: { 'conv-1': [] },
    ...options,
  });
}

async function sendMessage(text: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(/Message/), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('button', { name: 'Send' }); // streaming finished
}

describe('Chat', () => {
  it('sends a message and renders the streamed answer as markdown', async () => {
    const mock = resumedStub({
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
    resumedStub({
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
    resumedStub({
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

  it('greets a first-time visitor before any input', async () => {
    stubChatFetch({
      list: [],
      welcomeFrames: [
        'event: chunk\ndata: {"text":"Hi Alice, welcome!"}\n\n',
        'event: done\ndata: {"assistantMessageId":"w1"}\n\n',
      ],
    });
    render(<Chat csrfToken="token" />);

    expect(await screen.findByText('Hi Alice, welcome!')).toBeDefined();
    expect(localStorage.getItem('conversationId')).toBe('conv-1');
  });

  it('attaches an uploaded file to the next message', async () => {
    const mock = resumedStub({
      frames: [
        'event: chunk\ndata: {"text":"That screenshot shows a 404 error."}\n\n',
        'event: done\ndata: {"userMessageId":"u9","assistantMessageId":"a9"}\n\n',
      ],
    });
    render(<Chat csrfToken="token" />);
    await screen.findByRole('button', { name: 'Send' });

    const file = new File(['png-bytes'], 'shot.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText(/Attach/), { target: { files: [file] } });
    expect(await screen.findByText(/📎 shot\.png/)).toBeDefined();

    await sendMessage('what does this error mean?');

    expect(await screen.findByText('That screenshot shows a 404 error.')).toBeDefined();
    const send = mock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/messages') && init?.method === 'POST',
    );
    expect(JSON.parse(send![1]!.body as string)).toEqual({
      content: 'what does this error mean?',
      fileIds: ['file-9'],
    });
    // The chip stays on the sent message; the pending slot is cleared.
    expect(screen.getByText(/📎 shot\.png/)).toBeDefined();
  });

  it('fades in suggestion chips after the answer and sends one on click', async () => {
    const mock = resumedStub({
      frames: [
        'event: chunk\ndata: {"text":"Caching works like this."}\n\n',
        'event: done\ndata: {"userMessageId":"u1","assistantMessageId":"a1"}\n\n',
      ],
      suggestions: { forMessageId: 'a1', suggestions: ['What about eviction?'] },
    });
    render(<Chat csrfToken="token" />);

    await sendMessage('how does caching work?');
    expect(await screen.findByText('Caching works like this.')).toBeDefined();

    // Chips arrive a beat later (first poll fires after 1.5s) — correct UX.
    const chip = await screen.findByRole(
      'button',
      { name: 'What about eviction?' },
      { timeout: 5000 },
    );
    fireEvent.click(chip);
    await screen.findByRole('button', { name: 'Send' });

    const sends = mock.mock.calls.filter(
      ([url, init]) => String(url).endsWith('/messages') && init?.method === 'POST',
    );
    expect(JSON.parse(sends.at(-1)![1]!.body as string).content).toBe('What about eviction?');
  }, 15_000);

  it('streams a fresh greeting when New chat is clicked', async () => {
    const mock = resumedStub({
      history: { 'conv-1': [{ id: 'm1', role: 'user', content: 'old message' }] },
      welcomeFrames: [
        'event: chunk\ndata: {"text":"A fresh start!"}\n\n',
        'event: done\ndata: {"assistantMessageId":"w2"}\n\n',
      ],
    });
    render(<Chat csrfToken="token" />);
    await screen.findByText('old message');

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    expect(await screen.findByText('A fresh start!')).toBeDefined();
    expect(screen.queryByText('old message')).toBeNull();
    const welcome = mock.mock.calls.find(([url]) => String(url).endsWith('/welcome'));
    expect(welcome![1]?.headers).toMatchObject({ 'X-CSRF-Token': 'token' });
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
    resumedStub({
      history: { 'conv-1': [{ role: 'assistant', content: 'welcome back' }] },
    });
    render(<Chat csrfToken="token" />);

    expect(await screen.findByText('welcome back')).toBeDefined();
  });

  it('deletes a conversation with the CSRF token and clears the view', async () => {
    const mock = resumedStub({
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

  it('edits a user message: truncates the tail and streams the new answer', async () => {
    const mock = resumedStub({
      frames: [
        'event: chunk\ndata: {"text":"regenerated answer"}\n\n',
        'event: done\ndata: {"userMessageId":"u1b","assistantMessageId":"a1b"}\n\n',
      ],
      history: {
        'conv-1': [
          { id: 'u1', role: 'user', content: 'original question' },
          { id: 'a1', role: 'assistant', content: 'original answer' },
          { id: 'u2', role: 'user', content: 'follow-up' },
          { id: 'a2', role: 'assistant', content: 'follow-up answer' },
        ],
      },
    });
    render(<Chat csrfToken="token" />);
    await screen.findByText('original question');

    fireEvent.click(screen.getByRole('button', { name: /Edit message original question/ }));
    expect((screen.getByLabelText(/Message/) as HTMLTextAreaElement).value).toBe(
      'original question',
    );
    fireEvent.change(screen.getByLabelText(/Message/), {
      target: { value: 'edited question' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
    await screen.findByText('regenerated answer');

    // The old tail is gone from the view.
    expect(screen.queryByText('original answer')).toBeNull();
    expect(screen.queryByText('follow-up')).toBeNull();
    expect(screen.getByText('edited question')).toBeDefined();

    const edit = mock.mock.calls.find(([url]) => String(url).includes('/edit'));
    expect(String(edit![0])).toBe('/conversations/conv-1/messages/u1/edit');
    expect(edit![1]?.headers).toMatchObject({ 'X-CSRF-Token': 'token' });
  });
});
