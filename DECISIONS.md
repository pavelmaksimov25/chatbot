# Development decisions

Running log of non-obvious decisions made during implementation, newest slice
first. Architecture-level decisions predating this file live in the README
("Key design decisions"). Each entry says what was decided, why, and what was
rejected — so any of it can be revisited with context instead of archaeology.

## Slice 7 — Streaming chat turn

- **Model `claude-sonnet-4-6`, thinking off, `max_tokens` 1024 (env-overridable
  `LLM_MODEL` / `LLM_MAX_TOKENS`).** The roadmap pins Sonnet for chat (fast
  time-to-first-token ranks above maximum reasoning depth) and the current API
  budget is small. Thinking stays off rather than "adaptive" because TTFT is
  the explicit priority for the hot path.
- **The api trusts an `x-user-sub` header from the BFF.** The api is
  ClusterIP-only — Caddy routes the outside world exclusively to the BFF, so
  the header cannot be forged from outside the cluster. Rejected: passing a
  signed token per request (real service-to-service authn is a later concern,
  noted as a seam; overkill while there is exactly one internal caller).
- **SSE over `POST` + fetch-stream parsing in the SPA, not `EventSource`.**
  `EventSource` only does GET, and the message send is a mutating, CSRF-guarded
  POST. Wire format: `event: chunk|done|error` with JSON `data`, so the BFF can
  stay a dumb pipe.
- **Persistence is synchronous in the request, not BullMQ.** The roadmap puts
  queue infra in slice 16; persisting inline costs two inserts per turn. The
  user message is inserted *before* the LLM call (input is never lost); the
  assistant message is inserted only after the stream completes successfully.
  A mid-stream failure therefore persists no half-answer — the client gets an
  `error` event and the user retries from the intact user message. Rejected:
  persisting partials (would resurface as confusing truncated history).
- **Sanitizer rules (v1), explicitly left open by the design doc:** redact
  secret-shaped strings — Anthropic/OpenAI keys (`sk-ant-…`, `sk-…`), AWS
  access key ids (`AKIA…`), GitHub tokens (`ghp_…` family), private-key PEM
  headers — replaced with `[redacted]`. The sliding window holds back the last
  64 chars until more text arrives (or the stream ends) so a secret split
  across chunk boundaries cannot leak. PII redaction (emails, phone numbers)
  is deliberately NOT in v1: the false-positive cost in a chat product is high
  (the assistant legitimately echoes emails the user typed) and the design doc
  treats output sanitization as a backstop, not the primary defense.
- **Input-safety check (v1):** non-empty after trim, ≤ 8 000 chars, control
  characters stripped (except `\n`/`\t`). Prompt-injection heuristics are NOT
  attempted — the input-side security model is per-user context scoping (only
  the user's own active chain is ever assembled), not content policing.
- **Conversation id lives in the SPA's `localStorage`** (a non-secret UUID) so
  a reload resumes the same conversation. The conversation list UI is slice 8;
  storing the id locally keeps this slice from eating that one.
- **`messages.seq` is allocated as `max(seq)+1` inside a transaction** with the
  conversation row locked (`SELECT … FOR UPDATE`), serializing concurrent
  sends per conversation. Rejected: a global sequence (gaps break the
  per-conversation ordering contract) and app-side counters (race-prone).
- **System prompt is a fixed constant this slice** ("You are a helpful
  assistant…"). The cached stable prefix + per-user welcome content is slice
  10/13 territory; what matters now is that it already sits at the front of
  the request, where the cacheable prefix will live.
- **Failure boundary = the first *released* chunk.** A provider failure before
  the sanitizer has released anything is a plain HTTP 502/4xx (the client
  shows a normal error state); after streaming has started it becomes an SSE
  `error` event on the open stream. Note the sanitizer's 64-char holdback
  means "released", not "received" — a provider that dies 50 chars in still
  yields a clean 502, which is the better UX anyway.
- **Client disconnect aborts generation and persists nothing.** The BFF aborts
  the upstream fetch when the browser goes away; the api stops iterating the
  provider stream and the assistant message is never written. Rejected:
  finishing the generation server-side "for the history" (spends tokens on an
  answer nobody is waiting for; the user can re-ask).
