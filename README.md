# Chatbot

A standalone B2C conversational-AI web app (Claude/ChatGPT-class): streaming chat, conversation history with edit-and-regenerate, file analysis, and document export — built as a production-grade TypeScript system on Kubernetes.

> **Status:** architecture finalized, implementation starting. v1 targets a **local k8s cluster (kind + Helm)**; cloud deployment is deferred to v2.

## Product (v1)

- Streaming chat (SSE) — Claude Sonnet 4.6 primary, OpenAI → Gemini fallback
- Auth via Auth0: Google/GitHub/Microsoft + email/password with verification, silent re-auth
- Conversation history: edit (regenerate from the edited message), delete, auto-welcome
- File upload for analysis (text/PDF/images — vision input; no image generation), encrypted at rest
- Export answers/conversations to `.docx` / `.pdf` / `.csv`
- Follow-up suggestion chips, per-user daily usage quota

## Priorities

1. **Security**
2. **Latency** + **Maintainability**
3. Accuracy + UX

Every architectural tradeoff resolves in that order.

## Architecture

```
React/TS SPA
  │
Caddy (TLS / ingress)
  │
BFF gateway (NestJS) ─ Auth0 session in httpOnly cookies · CSRF · rate-limit · transparent SSE proxy
  ├─► api (NestJS, DDD modules) ──────────── owns conversations_db
  │     chat orchestration · LLM adapters · input/output safety ·
  │     file control + envelope encryption · usage quotas
  └─► user-service (NestJS, gRPC) ─────────── owns users_db
        app profile keyed by Auth0 sub (Redis-cached)

Async (BullMQ workers): output audit · docs-gen · suggestion chips · titles
Stores (in-cluster):    Postgres (2 logical DBs) · Redis/Valkey · MinIO · Vault (Transit = KMS)
External:               Auth0 · Anthropic / OpenAI / Gemini
Observability:          OpenTelemetry traces · Prometheus/Grafana · pino logs (trace-correlated)
```

## Key design decisions

- **BFF token model** — access tokens never reach the browser; sessions live server-side in `httpOnly + Secure + SameSite` cookies.
- **Envelope encryption at rest** — per-user data keys encrypt files in MinIO; key-encryption key in Vault Transit. No hand-rolled crypto.
- **Stream + async audit** — tokens stream with incremental sanitization; heavy policy checks run async. Primary security control is input-side context scoping.
- **Availability-first LLM fallback** — provider switch only before the first token; concurrency admission from rate-limit headers (Anthropic/OpenAI) + 429 circuit-breaker (Gemini).
- **BullMQ, not Kafka** — v1 async work is task-shaped; the synchronous chat path is in-process/gRPC. Kafka waits for a real streaming use case.
- **Full context + prompt caching** — the active message chain is sent each turn with Anthropic prompt caching on the stable prefix.
- **Edit = regenerate-linear** — editing truncates and regenerates; superseded messages are soft-flagged, with a schema seam for future branching.

## Deferred to v2

RAG / vector store (large-document chat) · branching edits · canvas-style artifacts · LLM-tool-triggered exports · long-term conversation memory · compaction · cloud deployment · paid tiers.

## Build order (tracer-bullet slices)

1. Walking skeleton — kind + Helm, empty services, stores, telemetry, CI
2. Auth (Auth0 via BFF) + user profile
3. Bare streaming chat turn (single provider) + persistence
4. Robust LLM layer — adapters, fallback, rate-limiting, prompt caching
5. History ops — edit-regenerate, delete, auto-welcome
6. Files — encrypted upload, inline analysis, caps
7. Async tail — audit, chips, titles
8. Docs-gen export
9. Quotas, dashboards, e2e smoke

## Local development

Prerequisites: Node.js ≥ 22, [pnpm](https://pnpm.io) 10; later slices add Docker, `kind`, `kubectl`, `helm`, `k9s`, an Auth0 tenant, and API keys for Anthropic, OpenAI, and Gemini.

```sh
pnpm install        # install all workspaces
pnpm dev            # start all services + SPA in watch mode
pnpm test           # unit tests across the monorepo
pnpm lint           # eslint
pnpm typecheck      # tsc --noEmit per package
pnpm build          # compile services + bundle SPA
```

| App                 | Port        | Role                                                             |
| ------------------- | ----------- | ---------------------------------------------------------------- |
| `apps/spa`          | 5173 (vite) | Chat UI (React)                                                  |
| `apps/bff-gateway`  | 3000        | The only service the browser talks to — session, CSRF, SSE proxy |
| `apps/api`          | 3001        | Domain core — chat orchestration, LLM adapters, conversations    |
| `apps/user-service` | 3002        | App profile keyed by Auth0 `sub` (gRPC later)                    |

Each service answers `GET /health`.

### Run on Kubernetes (kind)

```sh
make cluster-up     # create the kind cluster (host 8443 → Caddy ingress)
make images load    # build the service images and load them into kind
make deploy         # helm install + wait for rollout
make verify         # curl all three health endpoints through Caddy over HTTPS
make cluster-down   # teardown
```

Caddy terminates TLS (self-signed via its internal CA — use `curl -k`) and proxies to the
services. `https://localhost:8443/healthz/<service>` are skeleton-only verification routes;
real traffic flows through the BFF gateway at `https://localhost:8443/`.
