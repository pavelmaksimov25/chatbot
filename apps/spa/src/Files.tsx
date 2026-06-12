import { useCallback, useEffect, useRef, useState } from 'react';

interface FileItem {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
}

/** Encrypted file locker: upload, list, download. Files join chat in slice 15. */
export function Files({ csrfToken }: { csrfToken: string }) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const res = await fetch('/files').catch(() => null);
    if (res?.ok) {
      setFiles((await res.json()) as FileItem[]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = async (file: File): Promise<void> => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch('/files', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? 'the file could not be uploaded');
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the file could not be uploaded');
    } finally {
      setUploading(false);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  return (
    <section aria-label="Files">
      <h2>Files</h2>
      <label>
        Upload file{' '}
        <input
          ref={inputRef}
          type="file"
          accept=".txt,.md,.json,.pdf,image/*,text/*"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void upload(file);
            }
          }}
        />
      </label>
      {uploading && <p>Encrypting and uploading…</p>}
      {error && <p role="alert">{error}</p>}
      <ul>
        {files.map((file) => (
          <li key={file.id}>
            <a href={`/files/${encodeURIComponent(file.id)}`}>{file.name}</a>{' '}
            <small>({Math.ceil(file.sizeBytes / 1024)} KB)</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
