# secondbrain

## Quick Deploy

Set a shared password and run the deployment script (requires Cloudflare login):

```bash
export SHARED_PASSWORD='choose-a-long-random-password'
./deploy.sh
```

Or follow the manual steps below.

This repo contains a Cloudflare Workers MCP server that gives multiple AI tools a shared memory.

The Worker exposes `POST /mcp` using Cloudflare's remote MCP transport. It is protected by OAuth 2.1 with a shared password approval flow. Memory is hybrid:

- `D1` stores the canonical records
- `Vectorize` stores embeddings for semantic recall
- `Workers AI` generates embeddings with `@cf/baai/bge-base-en-v1.5`
- `Workers KV` stores OAuth client and token state

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

2. Create the OAuth KV namespace:

   ```bash
   npx wrangler kv namespace create cloudflare-memory-mcp-oauth --binding OAUTH_KV --update-config
   ```

3. Copy the returned `database_id` into `wrangler.jsonc`.

4. Create the Vectorize index:

   ```bash
   npx wrangler vectorize create cloudflare-memory-index --dimensions=768 --metric=cosine
   ```

5. Set the worker secret used by the password gate:

   ```bash
   npx wrangler secret put SHARED_PASSWORD
   ```

6. Apply the migration locally:

   ```bash
   npx wrangler d1 migrations apply cloudflare-memory-mcp --local
   ```

7. Start local dev:

   ```bash
   npm run dev
   ```

8. Apply the migration remotely, then deploy:

   ```bash
   npx wrangler d1 migrations apply cloudflare-memory-mcp --remote
   npm run deploy
   ```

To exercise the real Vectorize and Workers AI services during development, use remote dev:

```bash
npx wrangler dev --remote
```

## Endpoints

- `/` returns a small JSON description and OAuth metadata
- `/health` checks D1 and the Vectorize binding without exposing memory counts
- `/authorize` is the password approval page used by OAuth clients
- `/oauth/token` is the token exchange endpoint
- `/oauth/register` is the dynamic client registration endpoint
- `/mcp` is the protected MCP endpoint

## CI/CD Deployment

The repository includes a GitHub Action that auto-deploys on push to `main`. To enable it:

1. Get your Cloudflare **Account ID** from the Cloudflare dashboard sidebar.

2. Create a Cloudflare **API Token** for the target account with these permissions:
   - `Workers Scripts:Edit`
   - `Workers KV Storage:Edit`
   - `D1:Edit`
   - `Vectorize:Edit`
   - `Account:Read`

3. Add these to your GitHub repo:
   - `CLOUDFLARE_API_TOKEN` as a repository secret
   - `CLOUDFLARE_ACCOUNT_ID` as either a repository secret or variable
   - `SHARED_PASSWORD` as a repository secret

The workflow will:
- Validate that the required Cloudflare settings are present
- Create or reuse the OAuth KV namespace named `cloudflare-memory-mcp-oauth`
- Create or reuse the D1 database named `cloudflare-memory-mcp`
- Create or reuse the Vectorize index named `cloudflare-memory-index`
- Patch `wrangler.jsonc` at runtime with the real Cloudflare binding IDs
- Update the `SHARED_PASSWORD` worker secret
- Apply D1 migrations automatically
- Deploy the Worker on every push to `main`

## Connecting clients

Use your deployed Worker URL with `/mcp`, for example:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/mcp
```

If a client does not support remote MCP directly, use a local proxy such as `mcp-remote`.

## Notes

- `recall` blends semantic matches from Vectorize with keyword matches from D1.
- Clients will be redirected through OAuth and then asked for the shared password before they can use `/mcp`.
- For stronger production auth later, swap the shared-password page for GitHub, Google, or Cloudflare Access backed approval.
