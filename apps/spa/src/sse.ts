export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Incrementally parses an SSE body from fetch(). EventSource cannot send a
 * POST (the message send is CSRF-guarded), so the stream is read by hand.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed) {
          yield parsed;
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): SseEvent | null {
  const event = /^event: (.+)$/m.exec(frame)?.[1];
  const data = /^data: (.+)$/m.exec(frame)?.[1];
  if (!event || !data) {
    return null;
  }
  try {
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  } catch {
    return null;
  }
}
