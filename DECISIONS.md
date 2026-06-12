# Development decisions

Running log of non-obvious decisions made during implementation, newest slice
first. Architecture-level decisions predating this file live in the README
("Key design decisions"). Each entry says what was decided, why, and what was
rejected — so any of it can be revisited with context instead of archaeology.

## Slice 13 — Anthropic prompt caching

- **Two `cache_control` breakpoints, in the Anthropic provider only:** the
  stable system block, and the newest message of every request. Each turn
  re-reads the prefix the previous turn cached and extends it by one
  exchange. OpenAI and Gemini cache automatically — caching is a
  provider-specific concern that stays behind the adapter seam, untouched by
  ChatService. Rejected: a breakpoint per message (Anthropic caps breakpoints
  at 4; the newest-message pattern is the documented incremental idiom).
- **Prefix discipline was already done** — the deterministic system prompt
  (slice 10) and the constant welcome trigger ARE the discipline; the
  byte-identical-prefix test from slice 10 is the regression guard. Nothing
  volatile sits ahead of the breakpoints.
- **Caveat owned: Anthropic ignores `cache_control` below a ~1024-token
  minimum cacheable prefix (Sonnet).** Short conversations simply don't cache
  — requests stay valid, nothing breaks, and the cache engages exactly when
  it starts mattering. The live verification therefore uses a deliberately
  long first message.
- **Cache effectiveness is observable, not assumed:** `message_start` usage
  events feed `llm_cache_{read,creation}_tokens_total` + `llm_input_tokens_total`
  Prometheus counters and a per-turn pino log line.

## Slice 12 — Concurrency admission + per-provider rate limiting

- **One semaphore around the whole LLM call** (slot held from dispatch until
  the stream finishes), FIFO queue with a hard cap → queue overflow answers
  503 "at capacity". Implemented as a decorator around the fallback adapter so
  ChatService stays untouched. Defaults: DEFAULT=4, MAX=16, QUEUE=100
  (`LLM_CONCURRENCY_DEFAULT/MAX`, `LLM_QUEUE_MAX`).
- **Concurrency rises from DEFAULT toward MAX only on FRESH positive header
  evidence** (less than 60 s old, above floors of 2 requests / 10 k tokens)
  from the lead configured provider. Unknown or stale headroom is NOT
  optimistically trusted — the spec's "admit more only when headers show
  headroom", taken literally. Anthropic/OpenAI seed the registry from their
  rate-limit response headers via the SDKs' `withResponse()`.
- **Gemini gets a circuit breaker, not header tracking** — it has no reliable
  per-response headroom headers. A 429/RESOURCE_EXHAUSTED trips the circuit
  for the server-returned `retryDelay` (default 30 s when absent); the
  fallback walk skips open circuits and names them in the all-failed 503.
- **Headroom floors are conservative constants, not config** — the values
  (2 requests, 10 k tokens) only gate the DEFAULT→MAX upgrade; getting them
  wrong degrades to DEFAULT, which is always safe. Making them env knobs
  invites tuning theater.
- **Prometheus gauges** (`llm_in_flight`, `llm_queued`,
  `llm_concurrency_limit`, `llm_provider_requests_remaining`) make admission
  observable — they are how the behavior is verified live and what the
  Grafana dashboard (slice 20) will plot.

## Slice 11 — Multi-provider fallback + tier mapping

- **Provider order is FIXED: Anthropic → OpenAI → Gemini** (availability-first
  per the design doc). No health-based reordering, no cost router — uptime
  beats cleverness in v1, and a deterministic order makes incidents legible.
- **ANY pre-first-token failure falls through** — 429/5xx, network errors,
  timeouts, and also 400/401: a misconfigured key is indistinguishable from an
  unavailable provider from the user's seat. Unconfigured providers (empty
  key) are skipped without an attempt. After the first token the stream is
  committed — mid-stream failures propagate as the existing SSE error + retry,
  never a provider switch (the design doc's hard line).
- **First-token timeout 10 s** (`LLM_FIRST_TOKEN_TIMEOUT_MS`). On timeout the
  abandoned iterator is released fire-and-forget — awaiting `return()` on a
  hung async generator queues behind the stuck `next()` and deadlocks (found
  by the TDD suite, kept as a regression test).
- **Tier map (env-overridable per provider+tier):** default =
  `claude-sonnet-4-6` / `gpt-5` / `gemini-2.5-pro`; cheap = `claude-haiku-4-5`
  / `gpt-5-mini` / `gemini-2.5-flash`. A fallback answers on the SAME tier —
  quality/cost jumps must be explicit, never a side effect.
- **Live-verification boundary, honestly:** OPENAI/GEMINI keys are not
  provisioned, so the cross-provider fallback stream was verified against
  provider fakes only. Verified live instead: Anthropic-only turns still
  stream through the new adapter, and with the primary key disabled the chain
  walks to a clean 503. Streaming a real OpenAI/Gemini answer awaits keys —
  flagged to the project owner, no workaround attempted.

## Slice 10 — Auto-welcome

- **The welcome turn sends a CONSTANT, unpersisted user-role trigger** instead
  of an empty messages array. Anthropic requires the first message to be
  user-role, and a welcomed conversation's persisted chain starts with the
  assistant greeting — so chain assembly prepends the trigger whenever the
  chain is empty or assistant-first. Being a fixed string right after the
  system block, it _extends_ the stable cacheable prefix rather than breaking
  it. Rejected: persisting the trigger (it would show in the UI or, flagged
  inactive, vanish from context) and dropping the greeting from later context
  (the model would not know what it already said).
- **The profile block enters the system prompt for ALL turns now**, not just
  the welcome — `SYSTEM_PROMPT + name + preferences`, deterministic by
  construction (no timestamps, no request data; jsonb key order is normalized
  by Postgres). It changes only when the profile changes, which is exactly
  when the prompt cache SHOULD invalidate. A missing profile degrades to the
  generic prompt instead of failing the turn.
- **Welcome is only valid on an empty conversation (409 otherwise)** — it is
  a UI entry point, not a general "make the assistant speak" primitive.
- **The SPA auto-welcomes on first visit (no conversations) and on every
  New-chat click.** Repeatedly clicking New chat does create multiple
  greeted conversations — visible in the sidebar and deletable; acceptable
  for v1 over the complexity of reusing an existing empty conversation.

## Slice 9 — Edit-and-regenerate

- **The edited message is a NEW row appended with the next seq, not an
  in-place update of the original.** The original (and everything after it)
  flips `active = false` in the same transaction; the new row's
  `parent_message_id` points at the original — that is the version link the
  design doc reserved. Rejected: updating the row in place (destroys the
  audit trail and the v2 branching seam) and reusing the original's seq
  (violates the uniqueness constraint while the superseded row is kept).
- **Only active USER messages are editable**, and the target's existence is
  checked inside the same locked transaction that supersedes the tail — a
  double-edit of the same original (or a concurrent edit race) loses cleanly
  with a 404 instead of corrupting the chain.
- **The edit endpoint returns the same SSE wire as a normal send**
  (`POST …/messages/:messageId/edit`), so the BFF pipe, the SPA stream
  parser, and the failure semantics are identical — one streaming code path,
  not two.
- **The SPA adopts persisted message ids from the `done` event** instead of
  re-fetching the history after each turn. A refetch would be simpler but
  would replace the just-streamed view (visible flicker) for data we already
  have; ids are needed so the new turn is immediately editable.

## Slice 8 — Conversation history

- **Deleting a conversation is a hard `DELETE` (messages go via FK cascade),
  not a soft delete.** The issue says "conversation + messages removed", and
  user-initiated deletion of their own data should actually delete it. Soft
  flags in this codebase (`messages.active`) exist for _edit supersession_
  semantics, not deletion — conflating the two would make "delete my data"
  a lie.
- **The sidebar label is `title ?? preview`**, where `preview` is the first
  80 chars of the first active user message, computed in the list query.
  Generated titles are slice 17; shipping a list of "Untitled" rows until
  then is needless UX damage for one subquery.
- **List ordering is `updated_at DESC`** (most recently _touched_, not most
  recently created) — matches every mainstream chat product; `updated_at` is
  already bumped on each append from slice 7.
- **The SPA refreshes the sidebar after each completed turn** instead of
  optimistically reordering — one cheap GET against a BFF-local route, zero
  client-side ordering logic to get wrong.

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
  user message is inserted _before_ the LLM call (input is never lost); the
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
- **Failure boundary = the first _released_ chunk.** A provider failure before
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
