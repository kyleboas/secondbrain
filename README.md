![](./assets/logo.png)

# secondbrain

A shared memory server for your AI tools. Built on [Cloudflare Workers](https://workers.cloudflare.com/) and the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), secondbrain gives ChatGPT, Claude, Gemini, and any other MCP-compatible client a single place to store and retrieve memories -- so context learned in one tool is available everywhere.

### Why

AI assistants forget everything between conversations. When you use multiple tools the problem multiplies: insights from Claude never reach ChatGPT, notes saved in Gemini stay locked there, and you end up repeating yourself everywhere. secondbrain solves this by providing a unified, always-on memory layer that every tool can read from and write to.

### How it works

secondbrain exposes an MCP endpoint (`POST /mcp`) using Cloudflare's remote transport. Under the hood it uses a **hybrid storage architecture** that combines structured records with semantic search:

| Layer | Service | Role |
|-------|---------|------|
| Canonical store | Cloudflare D1 (SQLite) | Stores every memory with its metadata, tags, and namespace |
| Semantic index | Cloudflare Vectorize | Stores vector embeddings for meaning-based recall |
| Embedding model | Workers AI (`@cf/baai/bge-base-en-v1.5`) | Generates 768-dimension embeddings at the edge |

When you **remember** something, it is written to both D1 and Vectorize. When you **recall**, the server blends semantic matches (by meaning) with keyword matches (by text) and returns the most relevant results. This means you can search for concepts, not just exact words.

### Key features

- **Cross-tool memory** -- memories saved by one AI client are instantly available to all others
- **Hybrid recall** -- combines semantic similarity search with keyword ranking for accurate retrieval
- **Namespace isolation** -- organize memories into separate namespaces (e.g. `work`, `personal`, `project:atlas`)
- **Tagging** -- attach up to 16 tags per memory for filtering and categorization
- **Secure by default** -- bearer-token authentication with constant-time comparison; fails closed when no token is set
- **Graceful degradation** -- falls back to keyword-only search if the semantic index is unavailable
- **Edge-native** -- runs entirely on Cloudflare's edge network with no origin server required

### Tools

The server exposes four MCP tools:

| Tool | Description |
|------|-------------|
| `remember` | Save a memory with optional tags, namespace, and source reference |
| `recall` | Search or list memories using semantic + keyword hybrid retrieval |
| `forget` | Delete a specific memory by namespace and ID |
| `list_namespaces` | List all namespaces with memory counts |

---

License: MIT. See `LICENSE`.

For a step-by-step self-setup guide, see `SETUP.md`.

## Quick Deploy

Run the deployment script (requires Cloudflare login):

```bash
./deploy.sh
```

Or follow the manual steps below.

## Tools

- `remember`: save a memory in a namespace
- `recall`: search or list memories in a namespace
- `forget`: delete a memory by namespace and id
- `list_namespaces`: see what namespaces exist

## Setup

1. Create the D1 database:

   ```bash
   cd /home/workspace/secondbrain
   npx wrangler d1 create cloudflare-memory-mcp
   ```

2. Keep `wrangler.jsonc` clean.

   The checked-in config should keep the D1 binding by name only. Do not commit account-specific database IDs.

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
- `/health` checks that D1 and the Vectorize binding are ready
- `/mcp` is the MCP endpoint and now expects bearer auth by default

## CI/CD Deployment

The repository includes a GitHub Action that auto-deploys on push to `main`. To enable it:

1. Get your Cloudflare **Account ID** from the Cloudflare dashboard sidebar.

2. Create a Cloudflare **API Token** for the target account with these permissions:
   - `Workers Scripts:Edit`
   - `D1:Edit`
   - `Vectorize:Edit`
   - `Account:Read`

3. Add these to your GitHub repo:
   - `CLOUDFLARE_API_TOKEN` as a repository secret
   - `CLOUDFLARE_ACCOUNT_ID` as either a repository secret or variable

The workflow will:
- Validate that the required Cloudflare settings are present
- Create or reuse the D1 database named `cloudflare-memory-mcp`
- Create or reuse the Vectorize index named `cloudflare-memory-index`
- Patch `wrangler.jsonc` at runtime with the real D1 database ID
- Apply D1 migrations automatically
- Deploy the Worker on every push to `main`

## Connecting clients

Use your deployed Worker URL with `/mcp`, for example:

```text
https://cloudflare-memory-mcp.<your-subdomain>.workers.dev/mcp
```

Paste that URL into Claude (`Settings → Connectors`) or ChatGPT (custom connector settings). The client will discover OAuth automatically, redirect you to a login page, and store the access token — no manual token copying required.

For scripts and local proxies that set headers directly, the raw `MCP_SHARED_TOKEN` value still works as a bearer token.

If a client does not support remote MCP directly, use a local proxy such as `mcp-remote`.

## Authentication

The server has a built-in OAuth 2.0 authorization server. Set a Worker secret named `MCP_SHARED_TOKEN` — this becomes the admin password for the OAuth login page and the direct bearer token for scripts.

OAuth endpoints:

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/oauth-authorization-server` | Discovery metadata |
| `/oauth/register` | Dynamic client registration (RFC 7591) |
| `/oauth/authorize` | Login page — enter your `MCP_SHARED_TOKEN` password |
| `/oauth/token` | Token exchange (PKCE required) |

Issued OAuth access tokens expire automatically and are also invalidated when you rotate `MCP_SHARED_TOKEN`.

For local demos or deliberately public deployments you can opt out of auth entirely:

```text
ALLOW_UNAUTHENTICATED=true
```

That should be treated as a temporary development setting, not normal production mode.

## Notes

- `recall` blends semantic matches from Vectorize with keyword matches from D1.
- `forget` now deletes within a namespace, so callers must provide both `namespace` and `id`.
- Input sizes are capped to reduce abuse and accidental AI/storage blowups.
