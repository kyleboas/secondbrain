# secondbrain

This repo contains a Cloudflare Workers MCP server that gives multiple AI tools a shared memory.

The Worker exposes `POST /mcp` using Cloudflare's remote MCP transport. Memory is stored in D1, so ChatGPT, Claude, Gemini, Zo, or any other MCP client can share the same namespaces as long as they connect to the same Worker.

## Tools

- `remember`: save a memory in a namespace
- `recall`: search or list memories in a namespace
- `forget`: delete a memory by id
- `list_namespaces`: see what namespaces exist

## Setup

1. Create the D1 database:

   ```bash
   cd /home/workspace/secondbrain
   npx wrangler d1 create cloudflare-memory-mcp
   ```

2. Copy the returned `database_id` into `wrangler.jsonc`.

3. Apply the migration locally:

   ```bash
   npx wrangler d1 migrations apply cloudflare-memory-mcp --local
   ```

4. Start local dev:

   ```bash
   npm run dev
   ```

5. Apply the migration remotely, then deploy:

   ```bash
   npx wrangler d1 migrations apply cloudflare-memory-mcp --remote
   npm run deploy
   ```

## Endpoints

- `/` returns a small JSON description
- `/health` checks the D1 binding and table
- `/mcp` is the MCP endpoint

## Connecting clients

Use your deployed Worker URL with `/mcp`, for example:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/mcp
```

If a client does not support remote MCP directly, use a local proxy such as `mcp-remote`.

## Notes

- This starter uses keyword search in D1. If you want semantic recall, add embeddings plus Vectorize later.
- The project is public and authless right now. For production, wrap `/mcp` with Cloudflare Access or another OAuth provider.
