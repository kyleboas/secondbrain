# secondbrain setup

This guide shows how to set up and deploy the Cloudflare memory MCP server yourself.

## What this deploys

You are creating a Cloudflare Worker that exposes:

- `POST /mcp` for MCP clients
- `GET /health` for a quick health check
- `GET /` for basic metadata

Storage is split across:

- `D1` for the canonical memory records
- `Vectorize` for semantic search
- `Workers AI` for embeddings

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

## Current security model

This project is currently public and authless.

That means anyone who has the MCP URL can call it unless you add protection in front of it. For production use, put auth in front of `/mcp`, for example with Cloudflare Access or another auth layer.

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
- verify the Worker is reachable in a browser
- try a local MCP proxy if the client does not support remote MCP natively
