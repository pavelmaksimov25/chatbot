import type { ChatTurnMessage, LlmAdapter, StreamChatRequest } from './llm-adapter';

/**
 * Replay fake for tests: yields a recorded chunk sequence and captures what
 * the chat service actually sent, so specs can assert on the assembled
 * context without any provider call.
 */
export class FakeLlmAdapter implements LlmAdapter {
  readonly requests: StreamChatRequest[] = [];

  constructor(
    private chunks: string[],
    private failAfter = Infinity,
  ) {}

  /** Re-arm the replay for the next call. */
  replay(chunks: string[], failAfter = Infinity): void {
    this.chunks = chunks;
    this.failAfter = failAfter;
  }

  async *streamChat(request: StreamChatRequest): AsyncIterable<string> {
    this.requests.push({
      system: request.system,
      messages: request.messages.map((m): ChatTurnMessage => ({ ...m })),
    });
    let emitted = 0;
    for (const chunk of this.chunks) {
      if (emitted >= this.failAfter) {
        throw new Error('provider stream failed (replayed)');
      }
      emitted += 1;
      yield chunk;
      // A real stream yields across the event loop; mirroring that surfaces
      // ordering bugs that a fully synchronous fake would hide.
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (emitted >= this.failAfter) {
      throw new Error('provider stream failed (replayed)');
    }
  }
}
