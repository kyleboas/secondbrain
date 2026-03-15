import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OAuthProvider, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const EMBEDDING_POOLING = 'cls';
const AUTH_COOKIE_NAME = '__Host-secondbrain-csrf';
const SHARED_USER_ID = 'shared-password-user';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
	id TEXT PRIMARY KEY,
	namespace TEXT NOT NULL,
	content TEXT NOT NULL,
	tags TEXT NOT NULL DEFAULT '',
	source TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_namespace_created_at
ON memories(namespace, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_tags
ON memories(tags);
`;

type MemoryRow = {
	id: string;
	namespace: string;
	content: string;
	tags: string;
	source: string | null;
	created_at: string;
	score?: number;
};

type WorkerEnv = {
	AI: Ai;
	MEMORY_DB: D1Database;
	MEMORY_INDEX: VectorizeIndex;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	SHARED_PASSWORD: string;
};

type ClientInfo = {
	clientId: string;
	clientName?: string;
	clientUri?: string;
	logoUri?: string;
};

let schemaReady: Promise<void> | undefined;

function constantTimeEqual(a: string, b: string) {
	const aBytes = Buffer.from(a);
	const bBytes = Buffer.from(b);
	if (aBytes.length !== bBytes.length) {
		return false;
	}
	return timingSafeEqual(aBytes, bBytes);
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function sanitizeUrl(value?: string) {
	if (!value) {
		return '';
	}

	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
	} catch {
		return '';
	}
}

function getCookieValue(request: Request, name: string) {
	const cookieHeader = request.headers.get('cookie');
	if (!cookieHeader) {
		return '';
	}

	for (const item of cookieHeader.split(';')) {
		const [cookieName, ...rest] = item.trim().split('=');
		if (cookieName === name) {
			return rest.join('=');
		}
	}

	return '';
}

function issueCsrfCookie(token: string) {
	return `${AUTH_COOKIE_NAME}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
}

function clearCsrfCookie() {
	return `${AUTH_COOKIE_NAME}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;
}

function buildHtmlHeaders(setCookie?: string) {
	const contentSecurityPolicy = [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		"img-src https:",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"connect-src 'self'",
	].join('; ');

	const headers = new Headers({
		'content-security-policy': contentSecurityPolicy,
		'content-type': 'text/html; charset=utf-8',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
	});

	if (setCookie) {
		headers.set('set-cookie', setCookie);
	}

	return headers;
}

function renderAuthorizePage(request: Request, client: ClientInfo, requestedScopes: string[], csrfToken: string, error?: string) {
	const url = new URL(request.url);
	const safeName = escapeHtml(client.clientName?.trim() || 'MCP Client');
	const safeClientId = escapeHtml(client.clientId);
	const safeClientUri = sanitizeUrl(client.clientUri);
	const scopeList = requestedScopes.length > 0 ? requestedScopes.map(escapeHtml).join(', ') : 'none';
	const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : '';
	const clientUriHtml = safeClientUri
		? `<p><strong>Website</strong><br /><a href="${escapeHtml(safeClientUri)}" target="_blank" rel="noreferrer">${escapeHtml(safeClientUri)}</a></p>`
		: '';

	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Authorize ${safeName}</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background: #f3efe6;
        color: #1e1b16;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(219, 166, 108, 0.22), transparent 34%),
          linear-gradient(180deg, #f6f1e8 0%, #efe5d6 100%);
        padding: 24px;
      }
      .card {
        width: min(100%, 480px);
        background: rgba(255, 252, 247, 0.95);
        border: 1px solid rgba(71, 49, 22, 0.16);
        border-radius: 24px;
        box-shadow: 0 18px 48px rgba(58, 37, 15, 0.15);
        padding: 28px;
      }
      .eyebrow {
        display: inline-block;
        padding: 6px 10px;
        border-radius: 999px;
        background: #f1dfc4;
        color: #6b4a22;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 {
        margin: 14px 0 8px;
        font-size: 30px;
        line-height: 1.1;
      }
      p {
        margin: 0 0 14px;
        color: #5b4b35;
      }
      .panel {
        background: #fbf6ee;
        border: 1px solid rgba(71, 49, 22, 0.12);
        border-radius: 18px;
        padding: 16px;
        margin: 18px 0;
      }
      .panel p {
        margin: 0 0 10px;
      }
      .panel p:last-child {
        margin-bottom: 0;
      }
      label {
        display: block;
        font-weight: 600;
        margin-bottom: 8px;
      }
      input[type="password"] {
        width: 100%;
        box-sizing: border-box;
        border-radius: 14px;
        border: 1px solid rgba(71, 49, 22, 0.24);
        padding: 14px 16px;
        font-size: 16px;
        background: #fff;
      }
      .actions {
        display: flex;
        gap: 12px;
        margin-top: 20px;
      }
      button {
        border: 0;
        border-radius: 14px;
        cursor: pointer;
        font-size: 15px;
        font-weight: 700;
        padding: 14px 18px;
      }
      .approve {
        flex: 1;
        background: #1f6f4a;
        color: #fffaf1;
      }
      .cancel {
        background: #eadfce;
        color: #4e3d28;
      }
      .error {
        color: #9b2226;
        background: rgba(155, 34, 38, 0.08);
        border: 1px solid rgba(155, 34, 38, 0.18);
        border-radius: 12px;
        padding: 12px 14px;
      }
      a {
        color: #6b4a22;
      }
    </style>
  </head>
  <body>
    <form class="card" method="POST" action="/authorize?${escapeHtml(url.searchParams.toString())}">
      <span class="eyebrow">Protected Memory</span>
      <h1>${safeName} wants access</h1>
      <p>Enter your shared password to connect this MCP client to your secondbrain memory server.</p>
      ${errorHtml}
      <div class="panel">
        <p><strong>Client ID</strong><br />${safeClientId}</p>
        ${clientUriHtml}
        <p><strong>Requested scopes</strong><br />${scopeList}</p>
      </div>
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}" />
      <label for="password">Shared password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <div class="actions">
        <button class="cancel" type="button" onclick="history.back()">Cancel</button>
        <button class="approve" type="submit">Approve connection</button>
      </div>
    </form>
  </body>
</html>`;

	return new Response(html, { headers: buildHtmlHeaders(issueCsrfCookie(csrfToken)) });
}

function renderInfoPage() {
	return Response.json({
		name: 'cloudflare-memory-mcp',
		endpoint: '/mcp',
		auth: {
			type: 'oauth2.1+shared-password',
			authorizeEndpoint: '/authorize',
			tokenEndpoint: '/oauth/token',
			clientRegistrationEndpoint: '/oauth/register',
		},
		tools: ['remember', 'recall', 'forget', 'list_namespaces'],
		note: 'Shared memory uses OAuth before granting MCP access. D1 stores canonical records and Vectorize handles semantic recall.',
	});
}

function normalizeNamespace(value?: string) {
	const trimmed = value?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : 'global';
}

function normalizeTags(tags?: string[]) {
	return [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function serializeMemory(row: MemoryRow) {
	return {
		id: row.id,
		namespace: row.namespace,
		content: row.content,
		tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
		source: row.source,
		createdAt: row.created_at,
		score: row.score,
	};
}

function rowHasTag(row: Pick<MemoryRow, 'tags'>, tag: string) {
	if (!tag) {
		return true;
	}

	return row.tags
		.split(',')
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean)
		.includes(tag);
}

function uniqueById(rows: MemoryRow[]) {
	const seen = new Set<string>();
	return rows.filter((row) => {
		if (seen.has(row.id)) {
			return false;
		}
		seen.add(row.id);
		return true;
	});
}

async function ensureSchema(db: D1Database) {
	if (!schemaReady) {
		schemaReady = db.exec(SCHEMA_SQL).then(() => undefined).catch((error) => {
			schemaReady = undefined;
			throw error;
		});
	}
	await schemaReady;
}

async function embedText(env: WorkerEnv, text: string) {
	const result = (await env.AI.run(EMBEDDING_MODEL, {
		text: [text],
		pooling: EMBEDDING_POOLING,
	})) as Ai_Cf_Baai_Bge_Base_En_V1_5_Output;

	if (!('data' in result) || !result.data?.[0]) {
		throw new Error('Embedding model did not return a vector.');
	}

	return result.data[0];
}

async function fetchRowsByIds(env: WorkerEnv, namespace: string, ids: string[]) {
	if (ids.length === 0) {
		return [] as MemoryRow[];
	}

	const placeholders = ids.map((_, index) => `?${index + 2}`).join(', ');
	const statement = env.MEMORY_DB.prepare(
		`SELECT id, namespace, content, tags, source, created_at
		 FROM memories
		 WHERE namespace = ?1
		   AND id IN (${placeholders})`,
	).bind(namespace, ...ids);

	const { results } = await statement.all<MemoryRow>();
	const byId = new Map(results.map((row) => [row.id, row]));
	return ids.map((id) => byId.get(id)).filter((row): row is MemoryRow => Boolean(row));
}

async function queryRecentMemories(env: WorkerEnv, namespace: string, tag: string, limit: number) {
	const { results } = await env.MEMORY_DB.prepare(
		`SELECT id, namespace, content, tags, source, created_at
		 FROM memories
		 WHERE namespace = ?1
		   AND (?2 = '' OR tags LIKE '%' || ?2 || '%')
		 ORDER BY created_at DESC
		 LIMIT ?3`,
	)
		.bind(namespace, tag, limit)
		.all<MemoryRow>();

	return results;
}

async function queryKeywordMemories(env: WorkerEnv, namespace: string, query: string, tag: string, limit: number) {
	const { results } = await env.MEMORY_DB.prepare(
		`SELECT
			id,
			namespace,
			content,
			tags,
			source,
			created_at,
			(
				CASE WHEN lower(content) LIKE '%' || ?2 || '%' THEN 2 ELSE 0 END +
				CASE WHEN lower(tags) LIKE '%' || ?2 || '%' THEN 1 ELSE 0 END +
				CASE WHEN lower(COALESCE(source, '')) LIKE '%' || ?2 || '%' THEN 1 ELSE 0 END
			) AS score
		 FROM memories
		 WHERE namespace = ?1
		   AND (
			 lower(content) LIKE '%' || ?2 || '%'
			 OR lower(tags) LIKE '%' || ?2 || '%'
			 OR lower(COALESCE(source, '')) LIKE '%' || ?2 || '%'
		   )
		   AND (?3 = '' OR lower(tags) LIKE '%' || ?3 || '%')
		 ORDER BY score DESC, created_at DESC
		 LIMIT ?4`,
	)
		.bind(namespace, query, tag, limit)
		.all<MemoryRow>();

	return results;
}

async function querySemanticMemories(env: WorkerEnv, namespace: string, query: string, tag: string, limit: number) {
	const embedding = await embedText(env, query);
	const results = await env.MEMORY_INDEX.query(embedding, {
		topK: Math.min(limit * 3, 50),
		namespace,
	});

	const ids = results.matches.map((match) => match.id);
	const rows = await fetchRowsByIds(env, namespace, ids);
	const scoreById = new Map(results.matches.map((match) => [match.id, match.score]));

	return rows
		.filter((row) => rowHasTag(row, tag))
		.map((row) => ({
			...row,
			score: scoreById.get(row.id),
		}));
}

function createServer(env: WorkerEnv) {
	const server = new McpServer({
		name: 'cloudflare-memory-mcp',
		version: '0.2.0',
	});

	server.tool(
		'remember',
		'Store a shared memory that other MCP clients can retrieve later.',
		{
			namespace: z.string().optional(),
			content: z.string().min(1),
			tags: z.array(z.string()).optional(),
			source: z.string().optional(),
		},
		async ({ namespace, content, tags, source }) => {
			await ensureSchema(env.MEMORY_DB);

			const id = crypto.randomUUID();
			const normalizedNamespace = normalizeNamespace(namespace);
			const normalizedTags = normalizeTags(tags);
			const normalizedTagString = normalizedTags.join(',');
			const trimmedContent = content.trim();
			const trimmedSource = source?.trim() || null;

			await env.MEMORY_DB.prepare(
				`INSERT INTO memories (id, namespace, content, tags, source)
				 VALUES (?1, ?2, ?3, ?4, ?5)`,
			)
				.bind(id, normalizedNamespace, trimmedContent, normalizedTagString, trimmedSource)
				.run();

			let semanticIndexed = false;
			let warning: string | undefined;

			try {
				const embedding = await embedText(env, [trimmedContent, trimmedSource, normalizedTagString].filter(Boolean).join('\n'));
				await env.MEMORY_INDEX.upsert([
					{
						id,
						namespace: normalizedNamespace,
						values: embedding,
						metadata: {
							source: trimmedSource ?? '',
							tags: normalizedTags,
						},
					},
				]);
				semanticIndexed = true;
			} catch (error) {
				warning = error instanceof Error ? error.message : String(error);
			}

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								ok: true,
								id,
								namespace: normalizedNamespace,
								tags: normalizedTags,
								semanticIndexed,
								...(warning ? { warning } : {}),
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.tool(
		'recall',
		'Search shared memories inside a namespace by keyword or tag. Leave query empty to get the latest memories.',
		{
			namespace: z.string().optional(),
			query: z.string().optional(),
			tag: z.string().optional(),
			limit: z.number().int().min(1).max(25).optional(),
		},
		async ({ namespace, query, tag, limit }) => {
			await ensureSchema(env.MEMORY_DB);

			const normalizedNamespace = normalizeNamespace(namespace);
			const normalizedQuery = query?.trim().toLowerCase() ?? '';
			const normalizedTag = tag?.trim().toLowerCase() ?? '';
			const safeLimit = limit ?? 10;
			let results: MemoryRow[] = [];
			let retrievalMode = 'recent';
			let warnings: string[] = [];

			if (normalizedQuery.length === 0) {
				results = await queryRecentMemories(env, normalizedNamespace, normalizedTag, safeLimit);
			} else {
				retrievalMode = 'hybrid';

				const keywordResults = await queryKeywordMemories(
					env,
					normalizedNamespace,
					normalizedQuery,
					normalizedTag,
					safeLimit,
				);

				try {
					const semanticResults = await querySemanticMemories(
						env,
						normalizedNamespace,
						normalizedQuery,
						normalizedTag,
						safeLimit,
					);
					results = uniqueById([...semanticResults, ...keywordResults]).slice(0, safeLimit);
				} catch (error) {
					retrievalMode = 'keyword';
					warnings = [error instanceof Error ? error.message : String(error)];
					results = keywordResults;
				}
			}

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								ok: true,
								namespace: normalizedNamespace,
								retrievalMode,
								count: results.length,
								items: results.map(serializeMemory),
								...(warnings.length > 0 ? { warnings } : {}),
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.tool(
		'forget',
		'Delete one memory by id.',
		{
			id: z.string().min(1),
		},
		async ({ id }) => {
			await ensureSchema(env.MEMORY_DB);
			const result = await env.MEMORY_DB.prepare('DELETE FROM memories WHERE id = ?1').bind(id.trim()).run();
			let vectorDeleted = false;
			let warning: string | undefined;

			try {
				await env.MEMORY_INDEX.deleteByIds([id.trim()]);
				vectorDeleted = true;
			} catch (error) {
				warning = error instanceof Error ? error.message : String(error);
			}

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								ok: true,
								deleted: result.meta.changes ?? 0,
								id: id.trim(),
								vectorDeleted,
								...(warning ? { warning } : {}),
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.tool(
		'list_namespaces',
		'List the namespaces currently holding memories.',
		{},
		async () => {
			await ensureSchema(env.MEMORY_DB);
			const { results } = await env.MEMORY_DB.prepare(
				`SELECT namespace, COUNT(*) AS count, MAX(created_at) AS last_created_at
				 FROM memories
				 GROUP BY namespace
				 ORDER BY count DESC, namespace ASC`,
			).all<{ namespace: string; count: number; last_created_at: string | null }>();

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								ok: true,
								items: results.map((row: { namespace: string; count: number; last_created_at: string | null }) => ({
									namespace: row.namespace,
									count: Number(row.count),
									lastCreatedAt: row.last_created_at,
								})),
							},
							null,
							2,
						),
					},
				],
			};
		},
	);

	return server;
}

const apiHandler = {
	async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
		const server = createServer(env);
		return createMcpHandler(server)(request, env, ctx);
	},
};

const defaultHandler = {
	async fetch(request: Request, env: WorkerEnv) {
		const url = new URL(request.url);

		if (url.pathname === '/') {
			return renderInfoPage();
		}

		if (url.pathname === '/health') {
			try {
				await ensureSchema(env.MEMORY_DB);
				await env.MEMORY_INDEX.describe();
				return Response.json({
					ok: true,
					authRequired: true,
					authorizeEndpoint: '/authorize',
					embeddingModel: EMBEDDING_MODEL,
				});
			} catch (error) {
				return Response.json(
					{
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					},
					{ status: 500 },
				);
			}
		}

		if (url.pathname !== '/authorize') {
			return new Response('Not Found', { status: 404 });
		}

		if (!env.SHARED_PASSWORD) {
			return new Response('Server misconfigured: missing SHARED_PASSWORD', { status: 500 });
		}

		let oauthRequest;
		try {
			oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
		} catch (error) {
			return new Response(error instanceof Error ? error.message : 'Invalid authorization request', { status: 400 });
		}

		const client = (await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId)) as ClientInfo | undefined;

		if (!client) {
			return new Response('Invalid client_id', { status: 400 });
		}

		if (request.method === 'GET') {
			const csrfToken = crypto.randomUUID();
			return renderAuthorizePage(request, client, oauthRequest.scope, csrfToken);
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: { allow: 'GET, POST' },
			});
		}

		const formData = await request.formData();
		const csrfFromForm = String(formData.get('csrf_token') || '');
		const csrfFromCookie = getCookieValue(request, AUTH_COOKIE_NAME);
		if (!csrfFromForm || !csrfFromCookie || !constantTimeEqual(csrfFromForm, csrfFromCookie)) {
			return new Response('Invalid CSRF token', {
				status: 400,
				headers: buildHtmlHeaders(clearCsrfCookie()),
			});
		}

		const password = String(formData.get('password') || '');
		if (!constantTimeEqual(password, env.SHARED_PASSWORD)) {
			const csrfToken = crypto.randomUUID();
			return renderAuthorizePage(request, client, oauthRequest.scope, csrfToken, 'Wrong password.');
		}

		const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
			request: oauthRequest,
			userId: SHARED_USER_ID,
			metadata: {
				clientName: client.clientName || 'Unknown Client',
				label: 'Shared password access',
			},
			scope: oauthRequest.scope,
			props: {
				authMethod: 'shared-password',
				userId: SHARED_USER_ID,
			},
		});

		return new Response(null, {
			status: 302,
			headers: {
				location: redirectTo,
				'set-cookie': clearCsrfCookie(),
			},
		});
	},
};

export default new OAuthProvider<WorkerEnv>({
	accessTokenTTL: 3600,
	allowPlainPKCE: false,
	apiHandler,
	apiRoute: '/mcp',
	authorizeEndpoint: '/authorize',
	clientRegistrationEndpoint: '/oauth/register',
	defaultHandler,
	refreshTokenTTL: 2592000,
	tokenEndpoint: '/oauth/token',
});
