import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Files } from './Files';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFilesFetch(options: { uploadStatus?: number; uploadMessage?: string } = {}) {
  const { uploadStatus = 201, uploadMessage } = options;
  let listed = [{ id: 'f1', name: 'old.txt', mime: 'text/plain', sizeBytes: 2048 }];
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (uploadStatus >= 400) {
        return Promise.resolve(
          Response.json({ message: uploadMessage ?? 'rejected' }, { status: uploadStatus }),
        );
      }
      listed = [{ id: 'f2', name: 'new.txt', mime: 'text/plain', sizeBytes: 11 }, ...listed];
      return Promise.resolve(Response.json(listed[0], { status: 201 }));
    }
    return Promise.resolve(Response.json(listed));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('Files', () => {
  it('lists files with download links', async () => {
    stubFilesFetch();
    render(<Files csrfToken="token" />);
    const link = await screen.findByRole('link', { name: 'old.txt' });
    expect(link.getAttribute('href')).toBe('/files/f1');
  });

  it('uploads with the CSRF token and refreshes the list', async () => {
    const mock = stubFilesFetch();
    render(<Files csrfToken="token" />);
    await screen.findByRole('link', { name: 'old.txt' });

    const file = new File(['hello files'], 'new.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText(/Upload file/), { target: { files: [file] } });

    expect(await screen.findByRole('link', { name: 'new.txt' })).toBeDefined();
    const post = mock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post![1]?.headers).toMatchObject({ 'X-CSRF-Token': 'token' });
    expect(post![1]?.body).toBeInstanceOf(FormData);
  });

  it('shows the rejection message (caps) without breaking the page', async () => {
    stubFilesFetch({
      uploadStatus: 413,
      uploadMessage: 'file is too large — the limit is 5MB (large-document chat is coming in v2)',
    });
    render(<Files csrfToken="token" />);
    await screen.findByRole('link', { name: 'old.txt' });

    const file = new File(['x'.repeat(10)], 'big.bin', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText(/Upload file/), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('5MB'));
    expect(screen.getByRole('link', { name: 'old.txt' })).toBeDefined();
  });
});
