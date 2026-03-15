import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const EMBEDDING_POOLING = 'cls';

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
	AI: Ai;
	MEMORY_INDEX: VectorizeIndex;
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
				const vectorIndex = await env.MEMORY_INDEX.describe();
				return Response.json({
					ok: true,
					memoryCount: Number(row?.count ?? 0),
					vectorCount: vectorIndex.vectorsCount,
					vectorDimensions: 'dimensions' in vectorIndex.config ? vectorIndex.config.dimensions : vectorIndex.config.preset,
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

		if (url.pathname === '/') {
			return Response.json({
				name: 'cloudflare-memory-mcp',
				endpoint: '/mcp',
				tools: ['remember', 'recall', 'forget', 'list_namespaces'],
				note: 'Shared memory is hybrid: D1 stores the canonical records and Vectorize handles semantic recall.',
			});
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<WorkerEnv>;
