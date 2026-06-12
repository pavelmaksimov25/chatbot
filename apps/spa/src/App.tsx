import { useEffect, useState } from 'react';
import { Chat } from './Chat';
import { Files } from './Files';

interface Me {
  sub: string;
  email: string;
  name?: string;
  csrfToken: string;
}

interface Profile {
  sub: string;
  email: string;
  displayName: string;
  preferences: Record<string, unknown>;
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

  return <SignedIn me={auth.me} />;
}

function SignedIn({ me }: { me: Me }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draftName, setDraftName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/me')
      .then(async (res) => (res.ok ? ((await res.json()) as Profile) : null))
      .catch(() => null)
      .then((loaded) => {
        if (!cancelled && loaded) {
          setProfile(loaded);
          setDraftName(loaded.displayName);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = async (): Promise<void> => {
    await fetch('/auth/logout', {
      method: 'POST',
      headers: { 'X-CSRF-Token': me.csrfToken },
    });
    window.location.assign('/');
  };

  const saveName = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'X-CSRF-Token': me.csrfToken },
        body: JSON.stringify({ displayName: draftName }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? 'could not save the profile');
      }
      const updated = (await res.json()) as Profile;
      setProfile(updated);
      setDraftName(updated.displayName);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not save the profile');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main>
      <h1>Chatbot</h1>
      <p>Signed in as {profile?.displayName ?? me.name ?? me.email}</p>
      <Chat csrfToken={me.csrfToken} />
      <Files csrfToken={me.csrfToken} />
      {profile && (
        <section aria-label="Profile">
          <label>
            Display name{' '}
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              maxLength={100}
            />
          </label>{' '}
          <button
            onClick={() => void saveName()}
            disabled={saving || draftName.trim().length === 0 || draftName === profile.displayName}
          >
            Save
          </button>
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      <button onClick={() => void signOut()}>Sign out</button>
    </main>
  );
}
