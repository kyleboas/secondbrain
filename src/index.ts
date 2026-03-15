import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const EMBEDDING_POOLING = 'cls';
const MAX_NAMESPACE_LENGTH = 64;
const MAX_CONTENT_LENGTH = 4_000;
const MAX_SOURCE_LENGTH = 512;
const MAX_QUERY_LENGTH = 512;
const MAX_TAG_LENGTH = 64;
const MAX_TAG_COUNT = 16;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9:/_-]*$/;

const SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS memories (
		id TEXT PRIMARY KEY,
		namespace TEXT NOT NULL,
		content TEXT NOT NULL,
		tags TEXT NOT NULL DEFAULT '',
		source TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	)`,
	`CREATE INDEX IF NOT EXISTS idx_memories_namespace_created_at
	ON memories(namespace, created_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_memories_tags
	ON memories(tags)`,
];

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
	MEMORY_INDEX: VectorizeIndex | Vectorize;
	MCP_SHARED_TOKEN?: string;
	ALLOW_UNAUTHENTICATED?: string;
};

let schemaReady: Promise<void> | undefined;

function normalizeNamespace(value?: string) {
	const trimmed = value?.trim().toLowerCase();
	return trimmed && trimmed.length > 0 ? trimmed : 'global';
}

function validateNamespace(value?: string) {
	const normalized = normalizeNamespace(value);

	if (normalized.length > MAX_NAMESPACE_LENGTH) {
		throw new Error(`Namespace must be ${MAX_NAMESPACE_LENGTH} characters or fewer.`);
	}

	if (!NAMESPACE_PATTERN.test(normalized)) {
		throw new Error('Namespace may only contain lowercase letters, numbers, colon, slash, underscore, and hyphen.');
	}

	return normalized;
}

function normalizeTags(tags?: string[]) {
	const normalized = [...new Set((tags ?? []).map((tag) => tag.trim().toLowerCase()).filter(Boolean))];

	if (normalized.length > MAX_TAG_COUNT) {
		throw new Error(`A maximum of ${MAX_TAG_COUNT} tags is allowed.`);
	}

	for (const tag of normalized) {
		if (tag.length > MAX_TAG_LENGTH) {
			throw new Error(`Each tag must be ${MAX_TAG_LENGTH} characters or fewer.`);
		}
	}

	return normalized;
}

function normalizeTag(value?: string) {
	return normalizeTags(value ? [value] : [])[0] ?? '';
}

function normalizeContent(value: string) {
	const trimmed = value.trim();

	if (trimmed.length === 0) {
		throw new Error('Content cannot be empty.');
	}

	if (trimmed.length > MAX_CONTENT_LENGTH) {
		throw new Error(`Content must be ${MAX_CONTENT_LENGTH} characters or fewer.`);
	}

	return trimmed;
}

function normalizeSource(value?: string) {
	const trimmed = value?.trim();

	if (!trimmed) {
		return null;
	}

	if (trimmed.length > MAX_SOURCE_LENGTH) {
		throw new Error(`Source must be ${MAX_SOURCE_LENGTH} characters or fewer.`);
	}

	return trimmed;
}

function normalizeQuery(value?: string) {
	const trimmed = value?.trim().toLowerCase() ?? '';

	if (trimmed.length > MAX_QUERY_LENGTH) {
		throw new Error(`Query must be ${MAX_QUERY_LENGTH} characters or fewer.`);
	}

	return trimmed;
}

function normalizeId(value: string) {
	const trimmed = value.trim();

	if (trimmed.length === 0) {
		throw new Error('ID cannot be empty.');
	}

	if (trimmed.length > 128) {
		throw new Error('ID must be 128 characters or fewer.');
	}

	return trimmed;
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

function getVectorizeHealthDetails(indexDetails: Awaited<ReturnType<VectorizeIndex['describe']>> | Awaited<ReturnType<Vectorize['describe']>>) {
	const vectorCount =
		'vectorsCount' in indexDetails
			? indexDetails.vectorsCount
			: indexDetails.vectorCount;

	const vectorDimensions =
		'dimensions' in indexDetails
			? indexDetails.dimensions
			: 'dimensions' in indexDetails.config
				? indexDetails.config.dimensions
				: indexDetails.config.preset;

	return { vectorCount, vectorDimensions };
}

function isTruthy(value?: string) {
	return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function constantTimeEqual(left: string, right: string) {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);

	if (leftBytes.length !== rightBytes.length) {
		return false;
	}

	return timingSafeEqual(leftBytes, rightBytes);
}

function authorizeRequest(request: Request, env: WorkerEnv) {
	if (isTruthy(env.ALLOW_UNAUTHENTICATED)) {
		return { ok: true as const };
	}

	const sharedToken = env.MCP_SHARED_TOKEN?.trim();

	if (!sharedToken) {
		return {
			ok: false as const,
			response: Response.json(
				{
					ok: false,
					error: 'MCP_SHARED_TOKEN is not configured.',
				},
				{ status: 503 },
			),
		};
	}

	const authorization = request.headers.get('authorization');

	if (!authorization?.startsWith('Bearer ')) {
		return {
			ok: false as const,
			response: new Response(
				JSON.stringify({
					ok: false,
					error: 'Unauthorized.',
				}),
				{
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'WWW-Authenticate': 'Bearer',
					},
				},
			),
		};
	}

	const token = authorization.slice(7).trim();

	if (!constantTimeEqual(token, sharedToken)) {
		return {
			ok: false as const,
			response: new Response(
				JSON.stringify({
					ok: false,
					error: 'Unauthorized.',
				}),
				{
					status: 401,
					headers: {
						'Content-Type': 'application/json',
						'WWW-Authenticate': 'Bearer',
					},
				},
			),
		};
	}

	return { ok: true as const };
}

async function ensureSchema(db: D1Database) {
	if (!schemaReady) {
		schemaReady = (async () => {
			try {
				for (const statement of SCHEMA_STATEMENTS) {
					await db.prepare(statement).run();
				}
			} catch (error) {
				schemaReady = undefined;
				throw error;
			}
		})();
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
			const normalizedNamespace = validateNamespace(namespace);
			const normalizedTags = normalizeTags(tags);
			const normalizedTagString = normalizedTags.join(',');
			const trimmedContent = normalizeContent(content);
			const trimmedSource = normalizeSource(source);

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

				const normalizedNamespace = validateNamespace(namespace);
				const normalizedQuery = normalizeQuery(query);
				const normalizedTag = normalizeTag(tag);
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
		'Delete one memory by namespace and id.',
		{
			namespace: z.string().min(1),
			id: z.string().min(1),
		},
			async ({ id, namespace }) => {
				await ensureSchema(env.MEMORY_DB);
				const normalizedNamespace = validateNamespace(namespace);
				const trimmedId = normalizeId(id);
				const result = await env.MEMORY_DB.prepare('DELETE FROM memories WHERE namespace = ?1 AND id = ?2').bind(normalizedNamespace, trimmedId).run();
				const deleted = result.meta.changes ?? 0;
				let vectorDeleted = false;
				let warning: string | undefined;

				if (deleted > 0) {
					try {
						await env.MEMORY_INDEX.deleteByIds([trimmedId]);
						vectorDeleted = true;
					} catch (error) {
						warning = error instanceof Error ? error.message : String(error);
					}
				}

				return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
								{
									ok: true,
									deleted,
									id: trimmedId,
									namespace: normalizedNamespace,
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
			if (request.method !== 'OPTIONS') {
				const auth = authorizeRequest(request, env);
				if (!auth.ok) {
					return auth.response;
				}
			}

			const server = createServer(env);
			return createMcpHandler(server)(request, env, ctx);
		}

		if (url.pathname === '/health') {
			try {
				await ensureSchema(env.MEMORY_DB);
				const row = await env.MEMORY_DB.prepare('SELECT COUNT(*) AS count FROM memories').first<{ count: number }>();
				const vectorIndex = await env.MEMORY_INDEX.describe();
				const { vectorDimensions } = getVectorizeHealthDetails(vectorIndex);
				return Response.json({
					ok: true,
					vectorDimensions,
					embeddingModel: EMBEDDING_MODEL,
					memoryStoreReady: Number(row?.count ?? 0) >= 0,
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
				authenticated: !isTruthy(env.ALLOW_UNAUTHENTICATED),
				tools: ['remember', 'recall', 'forget', 'list_namespaces'],
				note: 'Shared memory is hybrid: D1 stores canonical records and Vectorize handles semantic recall.',
			});
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<WorkerEnv>;
