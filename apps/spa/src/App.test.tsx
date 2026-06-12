import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ME = {
  sub: 'auth0|u1',
  email: 'user@example.com',
  csrfToken: 'token',
};

const PROFILE = {
  sub: 'auth0|u1',
  email: 'user@example.com',
  displayName: 'Ace',
  preferences: {},
};

/** Route-aware fetch stub mirroring the BFF surface. */
function stubFetch(overrides: Record<string, (init?: RequestInit) => Response> = {}) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? 'GET'} ${url}`;
    if (overrides[key]) {
      return Promise.resolve(overrides[key](init));
    }
    if (url === '/auth/me') {
      return Promise.resolve(Response.json(ME));
    }
    if (url === '/me') {
      return Promise.resolve(Response.json(PROFILE));
    }
    return Promise.resolve(new Response('', { status: 404 }));
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('App', () => {
  it('offers sign-in when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    render(<App />);
    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link.getAttribute('href')).toBe('/auth/login');
  });

  it('shows the profile display name and sign-out when signed in', async () => {
    stubFetch();
    render(<App />);
    expect(await screen.findByText('Signed in as Ace')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
  });

  it('saves an edited display name with the CSRF token', async () => {
    const mock = stubFetch({
      'PATCH /me': () => Response.json({ ...PROFILE, displayName: 'New Name' }),
    });
    render(<App />);

    const input = await screen.findByLabelText(/Display name/);
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Signed in as New Name')).toBeDefined();
    const patch = mock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(String(patch![0])).toBe('/me');
    expect(patch![1]?.headers).toMatchObject({ 'X-CSRF-Token': 'token' });
    expect(patch![1]?.body).toBe(JSON.stringify({ displayName: 'New Name' }));
  });

  it('surfaces a failed save without losing the page', async () => {
    stubFetch({
      'PATCH /me': () =>
        Response.json({ message: 'displayName must be 1-100 characters' }, { status: 400 }),
    });
    render(<App />);

    const input = await screen.findByLabelText(/Display name/);
    fireEvent.change(input, { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText('Signed in as Ace')).toBeDefined();
  });
});
