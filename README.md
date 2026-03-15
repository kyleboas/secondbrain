# secondbrain

This repo contains a Cloudflare Workers MCP server that gives multiple AI tools a shared memory.

The Worker exposes `POST /mcp` using Cloudflare's remote MCP transport. Memory is hybrid:

- `D1` stores the canonical records
- `Vectorize` stores embeddings for semantic recall
- `Workers AI` generates embeddings with `@cf/baai/bge-base-en-v1.5`

That lets ChatGPT, Claude, Gemini, Zo, or any other MCP client share the same namespace and retrieve memories by meaning, not just exact keywords.

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

3. Create the Vectorize index:

   ```bash
   npx wrangler vectorize create cloudflare-memory-index --dimensions=768 --metric=cosine
   ```

4. Apply the migration locally:

   ```bash
   npx wrangler d1 migrations apply cloudflare-memory-mcp --local
   ```

5. Start local dev:

   ```bash
   npm run dev
   ```

6. Apply the migration remotely, then deploy:

   ```bash
   npx wrangler d1 migrations apply cloudflare-memory-mcp --remote
   npm run deploy
   ```

To exercise the real Vectorize and Workers AI services during development, use remote dev:

```bash
npx wrangler dev --remote
```

## Endpoints

- `/` returns a small JSON description
- `/health` checks D1 and the Vectorize binding
- `/mcp` is the MCP endpoint

## Connecting clients

Use your deployed Worker URL with `/mcp`, for example:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/mcp
```

If a client does not support remote MCP directly, use a local proxy such as `mcp-remote`.

## Notes

- `recall` blends semantic matches from Vectorize with keyword matches from D1.
- The project is public and authless right now. For production, wrap `/mcp` with Cloudflare Access or another OAuth provider.
