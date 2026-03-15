# secondbrain architecture

This project should be treated as **shared memory infrastructure**, not just an MCP server.

## The shape

```text
Claude   ─┐
ChatGPT  ─┼─> MCP adapter (/mcp) ─┐
Zo       ─┤                       │
blob     ─┼─> direct JSON API ----┼─> secondbrain core ----> D1 + Vectorize + Workers AI
Hermes   ─┘                       │
```

`secondbrain` already contains the core memory logic:
- canonical storage in D1
- semantic retrieval in Vectorize
- memory write/read heuristics
- auth

It now exposes that core in **two forms**:
- **MCP** at `/mcp` for cross-vendor chat clients
- **direct JSON API** at `/api/memory/*` for first-party adapters like `blob`

## Which clients should use what

| Client | Recommended integration | Why |
|---|---|---|
| Claude | MCP | Remote MCP is the natural integration surface |
| ChatGPT | MCP | Custom MCP works, but tool choice is still heuristic |
| Zo | Direct adapter first, MCP optional | Zo can integrate more directly than generic tool selection |
| blob | Direct JSON API | Most reliable for first-party memory read/write |
| Hermes Agent | Direct adapter first, MCP fallback | Better to plug memory into the agent directly than rely only on tool choice |

## Direct API

These endpoints are intended for first-party adapters and scripts:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/memory/lookup` | `POST` | Preferred read path before answering |
| `/api/memory/remember` | `POST` | Save one explicit memory |
| `/api/memory/auto-remember` | `POST` | Extract durable memories from raw text |
| `/api/memory/forget` | `POST` | Delete one memory by namespace and id |
| `/api/memory/namespaces` | `GET` | List namespaces |

Auth:
- send `Authorization: Bearer <MCP_SHARED_TOKEN>`
- OAuth tokens also work

## blob integration

`blob` should use `secondbrain` as its memory backend through the direct API, not through MCP.

Recommended behavior:
- before generating an answer or taking a user-facing action, call `/api/memory/lookup`
- after a turn completes, save durable facts with `/api/memory/auto-remember` or `/api/memory/remember`
- use namespaces like:
  - `blob:global`
  - `blob:user:<id>`
  - `blob:project:<slug>`

Minimal `blob` request flow:

1. `POST /api/memory/lookup`
   - body: `{ "namespace": "blob:user:123", "query": "<latest user message>", "limit": 6 }`
2. answer using only clearly relevant returned memories
3. `POST /api/memory/auto-remember`
   - body: `{ "namespace": "blob:user:123", "text": "<conversation excerpt>", "source": "blob:session:<id>" }`

## Zo integration

Zo should usually talk to `secondbrain` through a small Zo-side adapter or skill that calls the direct API. That gives you deterministic reads and writes instead of hoping a generic MCP client chooses the right tool on every turn.

## Hermes integration

Hermes Agent should ideally get a custom memory provider that maps its internal memory hooks to:
- `/api/memory/lookup`
- `/api/memory/remember`
- `/api/memory/auto-remember`

If that is not practical, MCP is the fallback.

## What MCP is for

Use MCP when you need interoperability across vendors.

Do **not** make MCP the only interface if you control both sides of the integration. For `blob`, direct API calls are the better path.
