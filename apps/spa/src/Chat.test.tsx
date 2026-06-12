import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function stubChatFetch(frames: string[]): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/conversations' && init?.method === 'POST') {
      return Promise.resolve(Response.json({ id: 'conv-1' }, { status: 201 }));
    }
    if (url === '/conversations/conv-1/messages' && init?.method === 'POST') {
      return Promise.resolve(sseResponse(frames));
    }
    if (url === '/conversations/conv-1/messages') {
      return Promise.resolve(Response.json([]));
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
    const mock = stubChatFetch([
      'event: chunk\ndata: {"text":"Here is **bold"}\n\n',
      'event: chunk\ndata: {"text":"** text"}\n\n',
      'event: done\ndata: {"conversationId":"conv-1"}\n\n',
    ]);
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
    stubChatFetch([
      'event: chunk\ndata: {"text":"<img src=x onerror=alert(1)> stays text"}\n\n',
      'event: done\ndata: {}\n\n',
    ]);
    const { container } = render(<Chat csrfToken="token" />);

    await sendMessage('inject');

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('stays text');
  });

  it('surfaces a mid-stream error without losing the conversation', async () => {
    stubChatFetch([
      'event: chunk\ndata: {"text":"partial"}\n\n',
      'event: error\ndata: {"message":"the answer was interrupted, try again"}\n\n',
    ]);
    render(<Chat csrfToken="token" />);

    await sendMessage('doomed');

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('doomed')).toBeDefined(); // user message kept
  });

  it('resumes a stored conversation on mount', async () => {
    localStorage.setItem('conversationId', 'conv-1');
    const mock = vi.fn((_url: RequestInfo | URL) =>
      Promise.resolve(
        Response.json([
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ]),
      ),
    );
    vi.stubGlobal('fetch', mock);
    render(<Chat csrfToken="token" />);

    expect(await screen.findByText('earlier question')).toBeDefined();
    expect(await screen.findByText('earlier answer')).toBeDefined();
    expect(String(mock.mock.calls[0][0])).toBe('/conversations/conv-1/messages');
  });
});
