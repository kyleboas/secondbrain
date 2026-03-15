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

`secondbrain` exposes the same memory core in two forms:
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

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/memory/lookup` | `POST` | Preferred direct lookup path |
| `/api/memory/retrieve` | `POST` | Wrapper-friendly pre-generation retrieval with `context` text |
| `/api/memory/remember` | `POST` | Save one explicit memory |
| `/api/memory/auto-remember` | `POST` | Extract durable memories from raw text |
| `/api/memory/forget` | `POST` | Delete one memory by namespace and id |
| `/api/memory/namespaces` | `GET` | List namespaces |

Auth:
- send `Authorization: Bearer <MCP_SHARED_TOKEN>`
- OAuth tokens also work

## blob integration

`blob` should use `secondbrain` through the direct API, not through MCP tool selection.

Recommended behavior:
- before generating an answer or taking a user-facing action, call `/api/memory/retrieve`
- after a turn completes, save durable facts with `/api/memory/auto-remember` or `/api/memory/remember`
- use namespaces like:
  - `blob:global`
  - `blob:user:<id>`
  - `blob:project:<slug>`

Minimal flow:

1. `POST /api/memory/retrieve`
   - body: `{ "message": "<latest user message>", "namespace": "blob:user:123", "limit": 6 }`
2. inject the returned `context` into the prompt only if present
3. answer
4. `POST /api/memory/auto-remember`
   - body: `{ "namespace": "blob:user:123", "text": "<conversation excerpt>", "source": "blob:session:<id>" }`

`/retrieve` remains available as a compatibility alias, but the `/api/memory/retrieve` route is the stable path for first-party adapters.
