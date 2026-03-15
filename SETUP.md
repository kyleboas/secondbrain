# secondbrain setup

This guide walks you through deploying your own instance of **secondbrain** -- a shared memory server that lets ChatGPT, Claude, Gemini, Zo, and any other MCP-compatible AI tool store and retrieve memories from one place. Memories are searched by meaning, not just keywords, so context learned in one tool is available everywhere.

For a high-level overview of the project and its architecture, see the [README](README.md).

## What this deploys

You are creating a Cloudflare Worker that exposes three endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/mcp` | `POST` | Main MCP protocol endpoint -- this is what AI clients connect to |
| `/health` | `GET` | Health check returning D1 and Vectorize status |
| `/` | `GET` | Basic service metadata |

The Worker uses three Cloudflare services for hybrid memory storage:

| Service | Binding | Role |
|---------|---------|------|
| D1 (SQLite) | `MEMORY_DB` | Canonical store for all memory records, tags, and metadata |
| Vectorize | `MEMORY_INDEX` | Vector index for semantic similarity search (768-dim, cosine) |
| Workers AI | `AI` | Generates embeddings with `@cf/baai/bge-base-en-v1.5` |

Once deployed, any MCP client can `remember` facts, `recall` them by meaning or keyword, `forget` specific entries, and `list_namespaces` to see how memories are organized.

## Before you start

You need:

- a Cloudflare account
- this repo checked out locally
- Node.js and npm installed
- `wrangler` available through `npx`

## 1. Install dependencies

```bash
npm install
```

## 2. Authenticate Wrangler

Use either browser login:

```bash
npx wrangler login
```

Or set a Cloudflare API token in your shell:

```bash
export CLOUDFLARE_API_TOKEN=your_token_here
export CLOUDFLARE_ACCOUNT_ID=your_account_id_here
```

If you use an API token, it should have at least:

- `Workers Scripts:Edit`
- `D1:Edit`
- `Vectorize:Edit`

If you later use a custom route or KV-backed auth, you may also need more permissions.

## 3. Create the D1 database

```bash
npx wrangler d1 create cloudflare-memory-mcp
```

Copy the returned database ID.

## 4. Create the Vectorize index

```bash
npx wrangler vectorize create cloudflare-memory-index --dimensions=768 --metric=cosine
```

## 5. Keep `wrangler.jsonc` clean

The checked-in config can keep the D1 binding by name only:

```json
"d1_databases": [
  {
    "binding": "MEMORY_DB",
    "database_name": "cloudflare-memory-mcp",
    "migrations_dir": "migrations"
  }
]
```

That avoids committing account-specific IDs to git.

If you are doing the very first setup and need to link the Worker to a specific existing D1 database, do that with a local-only config change or a one-off local deploy flow, but do not commit the database ID.

The Vectorize and AI bindings are already named correctly:

- `MEMORY_INDEX`
- `AI`

## 6. Apply the database migration

```bash
npx wrangler d1 migrations apply cloudflare-memory-mcp --remote
```

## 7. Deploy the Worker

```bash
npx wrangler deploy
```

When deployment finishes, Cloudflare will give you a URL like:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev
```

Your MCP endpoint is:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/mcp
```

## 7.5. Set the MCP auth secret

The Worker now expects bearer auth by default.

Add a Worker secret:

```bash
npx wrangler secret put MCP_SHARED_TOKEN
```

Clients should send:

```text
Authorization: Bearer <your-token>
```

If you intentionally want a public demo deployment, you can opt out with:

```bash
npx wrangler secret put ALLOW_UNAUTHENTICATED
```

and set its value to:

```text
true
```

Leaving the service unauthenticated is not recommended for normal use.

## 8. Verify it works

Check the root endpoint:

```bash
curl https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/
```

Check health:

```bash
curl https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/health
```

You want `/health` to return JSON with `"ok": true`.

## 9. Connect clients

Use the deployed `/mcp` URL in any MCP client that supports remote MCP.

Examples:

- Zo Computer: add a remote MCP server and use the `/mcp` URL
- Claude: add the remote MCP server URL in Claude's MCP settings
- ChatGPT: use the same remote MCP endpoint anywhere ChatGPT supports MCP connectors or remote MCP

If a client does not support remote MCP directly, use a local proxy such as `mcp-remote`.

### 9.1. Choose an auth mode before connecting ChatGPT or Claude

This repo now defaults to a shared bearer token via `MCP_SHARED_TOKEN`.

That works well for manual clients, scripts, `curl`, and local MCP proxies that let you set an `Authorization` header yourself.

For ChatGPT and Claude, the smoother direct setup is usually one of these:

- temporary demo mode with `ALLOW_UNAUTHENTICATED=true`
- an OAuth front door in front of the Worker

If you leave the server in bearer-token mode, make sure the client you are using can actually supply `Authorization: Bearer <your-token>` during MCP connection setup.

### 9.2. ChatGPT setup

ChatGPT's MCP/custom connector support changes by plan:

- Plus and Pro can use custom connectors, but Plus/Pro users must enable developer mode first
- Business, Enterprise, and Edu can use custom connectors too, but workspace admins may need to enable developer mode or grant access first
- full write/modify MCP support is documented for Business, Enterprise, and Edu workspaces; if your plan only exposes read/fetch access, expect `recall` and `list_namespaces` to work before `remember` and `forget`

Recommended setup flow:

1. Confirm you are using ChatGPT web and that developer mode is enabled for your account or workspace.
2. Open the custom app / custom connector creation flow in ChatGPT settings.
3. Paste your remote MCP endpoint:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/mcp
```

4. Pick the authentication method.
5. If you want the easiest first connection test, temporarily set `ALLOW_UNAUTHENTICATED=true` on the Worker, connect ChatGPT, confirm the tools appear, then move to a stronger auth setup.
6. If you want production access, prefer an OAuth-based setup in front of the Worker rather than relying on a shared bearer token.
7. After the connector is saved, open a new chat and use the tools / connectors picker to enable it.

If ChatGPT says the MCP server does not match its expected spec, treat that as a compatibility issue in the connector integration itself, not as a Cloudflare deployment problem.

### 9.3. Claude setup

Custom remote MCP connectors are available in Claude and Claude Desktop on paid Claude plans.

Recommended setup flow:

1. Open Claude or Claude Desktop.
2. Go to `Settings -> Connectors`.
3. Add a custom remote MCP server.
4. Paste your endpoint:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/mcp
```

5. If Claude prompts for auth, use an authless or OAuth-based setup that Claude supports.
6. Enable only the tools you actually want Claude to use.
7. Start a new conversation and invoke the connector from Claude's tools / connectors UI.

Important Claude-specific notes:

- for Claude Desktop, remote MCP servers must be added through `Settings -> Connectors`, not through `claude_desktop_config.json`
- Claude mobile can use remote servers that were already added through Claude web, but you cannot add a new one directly from mobile
- Claude officially documents authless and OAuth-based remote MCP support, so those are the safest connection modes to target

### 9.4. Practical recommendation

If your goal is just to prove the server works in ChatGPT and Claude:

1. temporarily set `ALLOW_UNAUTHENTICATED=true`
2. connect each client
3. verify that `remember`, `recall`, `forget`, and `list_namespaces` appear
4. then replace demo mode with a stronger production auth layer

If your goal is production use, do not leave the endpoint public. Put OAuth or another supported auth layer in front of it before you rely on it.

## Current security model

This project now fails closed by default unless `ALLOW_UNAUTHENTICATED=true` is explicitly set.

That means a normal deployment should require `Authorization: Bearer <token>` on `/mcp`.

## Troubleshooting

If deploy fails:

- run `npx wrangler whoami`
- confirm your token permissions
- confirm the D1 database ID in `wrangler.jsonc`
- confirm the Vectorize index name is `cloudflare-memory-index`

If health fails:

- re-run the remote migration
- confirm the Worker has bindings for `MEMORY_DB`, `MEMORY_INDEX`, and `AI`
- confirm you did not accidentally commit a stale placeholder `database_id`

If an MCP client cannot connect:

- make sure you used the full `/mcp` URL
- make sure the client is sending `Authorization: Bearer <your-token>`
- verify the Worker is reachable in a browser
- try a local MCP proxy if the client does not support remote MCP natively
