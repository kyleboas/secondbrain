import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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
	MEMORY_DB: D1Database;
};

let schemaReady: Promise<void> | undefined;

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

async function ensureSchema(db: D1Database) {
	if (!schemaReady) {
		schemaReady = db.exec(SCHEMA_SQL).then(() => undefined).catch((error) => {
			schemaReady = undefined;
			throw error;
		});
	}
	await schemaReady;
}

function createServer(env: WorkerEnv) {
	const server = new McpServer({
		name: 'cloudflare-memory-mcp',
		version: '0.1.0',
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
			const normalizedTags = normalizeTags(tags).join(',');

			await env.MEMORY_DB.prepare(
				`INSERT INTO memories (id, namespace, content, tags, source)
				 VALUES (?1, ?2, ?3, ?4, ?5)`,
			)
				.bind(id, normalizedNamespace, content.trim(), normalizedTags, source?.trim() || null)
				.run();

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								ok: true,
								id,
								namespace: normalizedNamespace,
								tags: normalizedTags ? normalizedTags.split(',') : [],
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

			const statement =
				normalizedQuery.length === 0
					? env.MEMORY_DB.prepare(
							`SELECT id, namespace, content, tags, source, created_at
							 FROM memories
							 WHERE namespace = ?1
							   AND (?2 = '' OR tags LIKE '%' || ?2 || '%')
							 ORDER BY created_at DESC
							 LIMIT ?3`,
					  ).bind(normalizedNamespace, normalizedTag, safeLimit)
					: env.MEMORY_DB.prepare(
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
					  ).bind(normalizedNamespace, normalizedQuery, normalizedTag, safeLimit);

			const { results } = await statement.all<MemoryRow>();

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								ok: true,
								namespace: normalizedNamespace,
								count: results.length,
								items: results.map(serializeMemory),
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

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							{
								ok: true,
								deleted: result.meta.changes ?? 0,
								id: id.trim(),
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

export default {
	async fetch(request, env: WorkerEnv, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/mcp') {
			const server = createServer(env);
			return createMcpHandler(server)(request, env, ctx);
		}

		if (url.pathname === '/health') {
			try {
				await ensureSchema(env.MEMORY_DB);
				const row = await env.MEMORY_DB.prepare('SELECT COUNT(*) AS count FROM memories').first<{ count: number }>();
				return Response.json({
					ok: true,
					memoryCount: Number(row?.count ?? 0),
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

		if (url.pathname === '/') {
			return Response.json({
				name: 'cloudflare-memory-mcp',
				endpoint: '/mcp',
				tools: ['remember', 'recall', 'forget', 'list_namespaces'],
				note: 'Shared memory lives in D1, so any MCP client that talks to this Worker can see the same namespace.',
			});
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<WorkerEnv>;
