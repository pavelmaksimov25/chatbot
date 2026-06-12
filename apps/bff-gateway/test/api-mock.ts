import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface StoredProfile {
  sub: string;
  email: string;
  displayName: string;
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * In-memory stand-in for the api's internal /profiles surface, mimicking its
 * semantics (ensure = get-or-create, 404 on unknown sub) so the BFF flows can
 * be tested end-to-end without the real api + user-service + valkey chain.
 */
export class ApiMock {
  readonly calls: RecordedCall[] = [];
  readonly profiles = new Map<string, StoredProfile>();
  /** SSE frames replayed by POST /conversations/:id/messages, one write each. */
  sseFrames: string[] = [
    'event: chunk\ndata: {"text":"Hello"}\n\n',
    'event: chunk\ndata: {"text":" world"}\n\n',
    'event: done\ndata: {"conversationId":"conv-1"}\n\n',
  ];

  private server!: Server;

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = req.url ?? '';
    const body = await readJson(req);
    this.calls.push({ method: req.method ?? '', path, body });

    if (req.method === 'POST' && path === '/profiles/ensure') {
      const { sub, email, displayName } = body as Record<string, string>;
      const existing = this.profiles.get(sub);
      const profile = existing ?? {
        sub,
        email,
        displayName,
        preferences: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.profiles.set(sub, profile);
      return json(res, 200, profile);
    }

    if (req.method === 'POST' && path === '/conversations') {
      return json(res, 201, { id: 'conv-1', userSub: req.headers['x-user-sub'], title: null });
    }

    if (req.method === 'GET' && path === '/conversations') {
      return json(res, 200, [
        { id: 'conv-2', title: null, preview: 'newer conversation' },
        { id: 'conv-1', title: null, preview: 'older conversation' },
      ]);
    }

    const convDelete = /^\/conversations\/([^/]+)$/.exec(path);
    if (convDelete && req.method === 'DELETE') {
      if (convDelete[1] === 'conv-1') {
        res.writeHead(204);
        res.end();
        return;
      }
      return json(res, 404, { message: 'conversation not found' });
    }

    const convMessages = /^\/conversations\/([^/]+)\/(?:messages(?:\/[^/]+\/edit)?|welcome)$/.exec(
      path,
    );
    if (convMessages && req.method === 'GET') {
      return json(res, 200, [
        { id: 'm1', role: 'user', content: 'hi', seq: 1 },
        { id: 'm2', role: 'assistant', content: 'Hello world', seq: 2 },
      ]);
    }
    if (convMessages && req.method === 'POST') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
      });
      // One write per frame across event-loop turns — a buffering proxy
      // would coalesce these; the spec asserts the full relayed payload.
      const frames = [...this.sseFrames];
      const writeNext = (): void => {
        const frame = frames.shift();
        if (frame === undefined) {
          res.end();
          return;
        }
        res.write(frame);
        setImmediate(writeNext);
      };
      writeNext();
      return;
    }

    if (path === '/files' && req.method === 'POST') {
      return json(res, 201, {
        id: 'f1',
        name: 'notes.txt',
        mime: 'text/plain',
        sizeBytes: 11,
        receivedContentType: req.headers['content-type'] ?? '',
        forUser: req.headers['x-user-sub'] ?? '',
      });
    }
    if (path === '/files' && req.method === 'GET') {
      return json(res, 200, [{ id: 'f1', name: 'notes.txt', mime: 'text/plain', sizeBytes: 11 }]);
    }
    if (path === '/files/f1' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="notes.txt"',
      });
      res.end('hello files');
      return;
    }

    const subMatch = /^\/profiles\/([^/]+)$/.exec(path);
    if (subMatch) {
      const sub = decodeURIComponent(subMatch[1]);
      const profile = this.profiles.get(sub);
      if (!profile) {
        return json(res, 404, { message: 'profile not found' });
      }
      if (req.method === 'GET') {
        return json(res, 200, profile);
      }
      if (req.method === 'PATCH') {
        const patch = body as { displayName?: string; preferences?: Record<string, unknown> };
        if (patch.displayName !== undefined && patch.displayName.trim().length === 0) {
          return json(res, 400, { message: 'displayName must be 1-100 characters' });
        }
        const updated: StoredProfile = {
          ...profile,
          ...(patch.displayName !== undefined && { displayName: patch.displayName.trim() }),
          ...(patch.preferences !== undefined && { preferences: patch.preferences }),
          updatedAt: new Date().toISOString(),
        };
        this.profiles.set(sub, updated);
        return json(res, 200, updated);
      }
    }

    json(res, 404, { message: `unhandled ${req.method} ${path}` });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}
