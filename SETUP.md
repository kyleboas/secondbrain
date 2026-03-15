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

Once deployed, any MCP client can `remember` facts, `auto_remember` likely long-lived facts from raw conversation text, `recall` memories by meaning or keyword, `forget` specific entries, and `list_namespaces` to see how memories are organized.

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

The Worker uses `MCP_SHARED_TOKEN` in two ways:

- as the direct bearer token for scripts and local MCP proxies
- as the password for the built-in OAuth login flow used by Claude, ChatGPT, and other browser-based clients

Add a Worker secret:

```bash
npx wrangler secret put MCP_SHARED_TOKEN
```

Scripts and local proxies can send:

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

The server has a built-in OAuth 2.0 authorization server. Any MCP client that supports OAuth (Claude, ChatGPT, and most others) will handle the login flow automatically — you just paste the URL.

### 9.1. Claude setup

1. Open Claude or Claude Desktop.
2. Go to `Settings → Connectors`.
3. Add a custom remote MCP server and paste your endpoint:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/mcp
```

4. Claude will discover OAuth automatically and redirect you to a login page.
5. Enter your `MCP_SHARED_TOKEN` password and click **Authorize access**.
6. Claude stores the access token. Done — no further auth steps needed.

Notes:
- For Claude Desktop, remote MCP servers must be added through `Settings → Connectors`, not `claude_desktop_config.json`.
- Claude mobile can use servers already added through Claude web, but cannot add new ones directly from mobile.

### 9.2. ChatGPT setup

ChatGPT MCP connector support varies by plan (Plus/Pro require developer mode; Business/Enterprise/Edu may need workspace admin approval).

1. Enable developer mode for your account or workspace.
2. Open the custom connector creation flow in ChatGPT settings.
3. Paste your endpoint:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/mcp
```

4. Select OAuth as the authentication method when prompted.
5. ChatGPT will redirect you to the secondbrain login page — enter your `MCP_SHARED_TOKEN` password.
6. After authorizing, open a new chat and enable the connector from the tools picker.

### 9.3. Other clients and scripts

The server still accepts the raw `MCP_SHARED_TOKEN` as a bearer token, so scripts, `curl`, and local MCP proxies continue to work without any changes:

```text
Authorization: Bearer <your-MCP_SHARED_TOKEN>
```

If a client does not support remote MCP directly, use a local proxy such as `mcp-remote`.

### 9.4. Using `auto_remember`

`auto_remember` is the tool to use when you want a client to save likely durable memories from a block of conversation text.

Important:

- the server now advertises `auto_remember` as the preferred conversation-writing tool, while `remember` is described as the single-fact fallback
- it is explicit, not ambient — nothing is stored unless the client calls `auto_remember`
- it works best on plain conversation transcripts, summaries, or meeting notes
- it uses conservative heuristics and skips exact duplicate memory content inside the same namespace
- use `dryRun=true` first if you want to preview what would be stored

## Current security model

The server fails closed by default unless `ALLOW_UNAUTHENTICATED=true` is explicitly set.

`/mcp` requires a valid token on every request. Tokens can be:

- the raw `MCP_SHARED_TOKEN` value (for scripts and local proxies)
- an OAuth access token issued through the built-in OAuth flow (for Claude, ChatGPT, and browser-based clients)

OAuth tokens are stored in D1, expire automatically, and are invalidated if you rotate `MCP_SHARED_TOKEN`. To revoke all OAuth sessions immediately, run:

```bash
npx wrangler d1 execute cloudflare-memory-mcp --remote --command "DELETE FROM oauth_tokens"
```

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
