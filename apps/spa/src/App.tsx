import { useEffect, useState } from 'react';

interface Me {
  sub: string;
  email: string;
  name?: string;
  csrfToken: string;
}

type AuthState = { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; me: Me };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void fetch('/auth/me')
      .then(async (res) => (res.ok ? ((await res.json()) as Me) : null))
      .catch(() => null)
      .then((me) => {
        if (!cancelled) {
          setAuth(me ? { status: 'signed-in', me } : { status: 'signed-out' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (auth.status === 'loading') {
    return (
      <main>
        <h1>Chatbot</h1>
        <p>Loading…</p>
      </main>
    );
  }

  if (auth.status === 'signed-out') {
    const error = new URLSearchParams(window.location.search).get('error');
    return (
      <main>
        <h1>Chatbot</h1>
        {error === 'email_not_verified' && (
          <p role="alert">Please verify your email address, then sign in again.</p>
        )}
        {/* Full-page redirect: the BFF owns the whole OAuth dance. */}
        <a href="/auth/login">Sign in</a>
      </main>
    );
  }

  const { me } = auth;
  const signOut = async (): Promise<void> => {
    await fetch('/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': me.csrfToken },
    });
    window.location.assign('/');
  };

  return (
    <main>
      <h1>Chatbot</h1>
      <p>Signed in as {me.name ?? me.email}</p>
      <p>Chat lands here in the next slice.</p>
      <button onClick={() => void signOut()}>Sign out</button>
    </main>
  );
}
