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
const MAX_AUTO_REMEMBER_TEXT_LENGTH = 12_000;
const MAX_AUTO_REMEMBER_ITEMS = 8;
const MAX_REDIRECT_URI_LENGTH = 2_048;
const MAX_REDIRECT_URI_COUNT = 10;
const MAX_CLIENT_NAME_LENGTH = 128;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9:/_-]*$/;
const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

const OAUTH_SCHEMA_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS oauth_clients (
		id TEXT PRIMARY KEY,
		redirect_uris TEXT NOT NULL,
		name TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	)`,
	`CREATE TABLE IF NOT EXISTS oauth_codes (
		code TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		redirect_uri TEXT NOT NULL,
		code_challenge TEXT,
		code_challenge_method TEXT,
		expires_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS oauth_tokens (
		token TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		secret_fingerprint TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	)`,
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

type OAuthClientRow = {
	id: string;
	redirect_uris: string;
	name: string | null;
};

type OAuthCodeRow = {
	code: string;
	client_id: string;
	redirect_uri: string;
	code_challenge: string | null;
	code_challenge_method: string | null;
	expires_at: string;
};

type OAuthTokenRow = {
	token: string;
	client_id: string;
	expires_at: string | null;
	secret_fingerprint: string | null;
};

type StoredMemoryResult = {
	ok: true;
	id: string;
	namespace: string;
	tags: string[];
	semanticIndexed: boolean;
	warning?: string;
};

type AutoRememberCandidate = {
	content: string;
	tags: string[];
	score: number;
	reason: string;
};

type WorkerEnv = {
	MEMORY_DB: D1Database;
	AI: Ai;
	MEMORY_INDEX: VectorizeIndex | Vectorize;
	MCP_SHARED_TOKEN?: string;
	ALLOW_UNAUTHENTICATED?: string;
};

let schemaReady: Promise<void> | undefined;
let oauthSchemaReady: Promise<void> | undefined;

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

function normalizeAutoRememberText(value: string) {
	const trimmed = value.trim();

	if (trimmed.length === 0) {
		throw new Error('text cannot be empty.');
	}

	if (trimmed.length > MAX_AUTO_REMEMBER_TEXT_LENGTH) {
		throw new Error(`text must be ${MAX_AUTO_REMEMBER_TEXT_LENGTH} characters or fewer.`);
	}

	return trimmed;
}

function normalizeAutoRememberItems(value?: number) {
	const safeValue = value ?? 3;

	if (!Number.isInteger(safeValue) || safeValue < 1 || safeValue > MAX_AUTO_REMEMBER_ITEMS) {
		throw new Error(`maxItems must be an integer between 1 and ${MAX_AUTO_REMEMBER_ITEMS}.`);
	}

	return safeValue;
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

function generateToken(bytes = 32): string {
	const array = new Uint8Array(bytes);
	crypto.getRandomValues(array);
	return btoa(String.fromCharCode(...array))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');
}

async function verifyPkceChallenge(verifier: string, challenge: string): Promise<boolean> {
	const data = new TextEncoder().encode(verifier);
	const digest = await crypto.subtle.digest('SHA-256', data);
	const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');
	return base64url === challenge;
}

function base64UrlEncode(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');
}

async function sha256Base64Url(value: string) {
	const data = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return base64UrlEncode(new Uint8Array(digest));
}

function isLoopbackHostname(hostname: string) {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function validateRedirectUri(value: string) {
	const trimmed = value.trim();

	if (trimmed.length === 0) {
		throw new Error('redirect_uri cannot be empty.');
	}

	if (trimmed.length > MAX_REDIRECT_URI_LENGTH) {
		throw new Error(`redirect_uri must be ${MAX_REDIRECT_URI_LENGTH} characters or fewer.`);
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error('redirect_uri must be a valid absolute URL.');
	}

	if (url.hash) {
		throw new Error('redirect_uri must not include a fragment.');
	}

	if (url.username || url.password) {
		throw new Error('redirect_uri must not include userinfo.');
	}

	if (url.protocol === 'https:') {
		return url.toString();
	}

	if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) {
		return url.toString();
	}

	throw new Error('redirect_uri must use https or loopback http.');
}

function parseRedirectUris(value: string) {
	try {
		const parsed = JSON.parse(value) as unknown;

		if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
			throw new Error('Stored redirect URIs are invalid.');
		}

		return parsed.map((uri) => validateRedirectUri(uri));
	} catch {
		const fallback = value.split(' ').filter(Boolean);

		if (fallback.length === 0) {
			throw new Error('Stored redirect URIs are invalid.');
		}

		return fallback.map((uri) => validateRedirectUri(uri));
	}
}

function normalizeRedirectUris(value: unknown) {
	if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
		throw new Error('redirect_uris must be a non-empty array of strings.');
	}

	if (value.length > MAX_REDIRECT_URI_COUNT) {
		throw new Error(`A maximum of ${MAX_REDIRECT_URI_COUNT} redirect URIs is allowed.`);
	}

	return [...new Set(value.map((uri) => validateRedirectUri(uri)))];
}

function normalizeClientName(value: unknown) {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	if (trimmed.length > MAX_CLIENT_NAME_LENGTH) {
		throw new Error(`client_name must be ${MAX_CLIENT_NAME_LENGTH} characters or fewer.`);
	}

	return trimmed;
}

function collapseWhitespace(value: string) {
	return value.replace(/\s+/g, ' ').trim();
}

function splitAutoRememberSegments(text: string) {
	const lineParts = text
		.split(/\r?\n+/)
		.map((line) => collapseWhitespace(line))
		.filter(Boolean);

	const sentenceParts = collapseWhitespace(text)
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => collapseWhitespace(sentence))
		.filter(Boolean);

	const seen = new Set<string>();
	return [...lineParts, ...sentenceParts].filter((segment) => {
		const key = segment.toLowerCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function inferAutoRememberTags(segment: string) {
	const lowered = segment.toLowerCase();
	const tags: string[] = [];

	if (/\b(my name is|call me|i go by|i am|i'm)\b/.test(lowered)) {
		tags.push('identity');
	}
	if (/\b(i prefer|i like|i love|i dislike|i hate|i avoid|i use|i always|i never)\b/.test(lowered)) {
		tags.push('preference');
	}
	if (/\b(i need to|i want to|my goal is|i plan to|deadline|due\b|ship\b|launch\b|deploy\b)\b/.test(lowered)) {
		tags.push('goal');
	}
	if (/\b(i'm working on|i am working on|we're building|we are building|my project|this repo|secondbrain)\b/.test(lowered)) {
		tags.push('project');
	}
	if (/\b(do not|don't|never|always|must|should|prefer)\b/.test(lowered)) {
		tags.push('constraint');
	}

	return tags;
}

function scoreAutoRememberSegment(segment: string) {
	const lowered = segment.toLowerCase();
	let score = 0;
	let reason = 'general';
	const hasStrongSignal = /\b(my name is|call me|i go by|i am|i'm|i prefer|i like|i love|i dislike|i hate|i avoid|i use|i always|i never|i need to|i want to|my goal is|i plan to|i'm working on|i am working on|we're building|we are building|my project|remember|please remember)\b/.test(lowered);

	if (segment.length < 10 || segment.length > MAX_CONTENT_LENGTH) {
		return { score: -100, reason: 'length' };
	}

	if (segment.length < 18 && !hasStrongSignal) {
		return { score: -100, reason: 'length' };
	}

	if (segment.endsWith('?') && !/\b(remember|please remember)\b/.test(lowered)) {
		return { score: -100, reason: 'question' };
	}

	if (/^(thanks|thank you|ok|okay|cool|sounds good|got it|sure|yes|no)[.!]?$/i.test(segment)) {
		return { score: -100, reason: 'filler' };
	}

	if (/\b(my name is|call me|i go by)\b/.test(lowered)) {
		score += 6;
		reason = 'identity';
	}
	if (/\b(i prefer|i like|i love|i dislike|i hate|i avoid|i use|i always|i never)\b/.test(lowered)) {
		score += 5;
		reason = reason === 'general' ? 'preference' : reason;
	}
	if (/\b(i need to|i want to|my goal is|i plan to|deadline|due\b|ship\b|launch\b|deploy\b)\b/.test(lowered)) {
		score += 4;
		reason = reason === 'general' ? 'goal' : reason;
	}
	if (/\b(i'm working on|i am working on|we're building|we are building|my project)\b/.test(lowered)) {
		score += 4;
		reason = reason === 'general' ? 'project' : reason;
	}
	if (/\b(remember|please remember)\b/.test(lowered)) {
		score += 6;
		reason = 'explicit';
	}
	if (/\b(do not|don't|never|always|must|should)\b/.test(lowered)) {
		score += 2;
	}

	if (!/[a-z]/i.test(segment)) {
		score -= 100;
	}

	return { score, reason };
}

function extractAutoRememberCandidates(text: string, maxItems: number) {
	const candidates = splitAutoRememberSegments(text)
		.map((segment) => {
			const normalized = collapseWhitespace(segment);
			const { score, reason } = scoreAutoRememberSegment(normalized);
			return {
				content: normalized,
				tags: inferAutoRememberTags(normalized),
				score,
				reason,
			} satisfies AutoRememberCandidate;
		})
		.filter((candidate) => candidate.score >= 4)
		.sort((left, right) => right.score - left.score || left.content.length - right.content.length);

	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = candidate.content.toLowerCase();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	}).slice(0, maxItems);
}

function htmlEscape(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization',
	};
}

function getBaseUrl(url: URL) {
	return `${url.protocol}//${url.host}`;
}

function getProtectedResourceMetadata(url: URL) {
	const baseUrl = getBaseUrl(url);
	return {
		resource: `${baseUrl}/mcp`,
		authorization_servers: [baseUrl],
		bearer_methods_supported: ['header'],
	};
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

async function ensureOAuthSchema(db: D1Database) {
	if (!oauthSchemaReady) {
		oauthSchemaReady = (async () => {
			try {
				for (const statement of OAUTH_SCHEMA_STATEMENTS) {
					await db.prepare(statement).run();
				}
			} catch (error) {
				oauthSchemaReady = undefined;
				throw error;
			}
		})();
	}
	await oauthSchemaReady;
}

async function authorizeRequest(request: Request, env: WorkerEnv) {
	if (isTruthy(env.ALLOW_UNAUTHENTICATED)) {
		return { ok: true as const };
	}

	const sharedToken = env.MCP_SHARED_TOKEN?.trim() || null;
	const authorization = request.headers.get('authorization');
	const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : null;

	// Fast path: shared bearer token (backward compatible)
	if (token && sharedToken && constantTimeEqual(token, sharedToken)) {
		return { ok: true as const };
	}

	// Check OAuth access tokens in D1
	if (token && sharedToken) {
		await ensureOAuthSchema(env.MEMORY_DB);
		const secretFingerprint = await sha256Base64Url(sharedToken);
		const row = await env.MEMORY_DB
			.prepare('SELECT token, client_id, expires_at, secret_fingerprint FROM oauth_tokens WHERE token = ?1')
			.bind(token)
			.first<OAuthTokenRow>();
		if (row) {
			if (!row.expires_at || !row.secret_fingerprint) {
				await env.MEMORY_DB.prepare('DELETE FROM oauth_tokens WHERE token = ?1').bind(token).run();
			} else if (new Date(row.expires_at) < new Date()) {
				await env.MEMORY_DB.prepare('DELETE FROM oauth_tokens WHERE token = ?1').bind(token).run();
			} else if (constantTimeEqual(row.secret_fingerprint, secretFingerprint)) {
				return { ok: true as const };
			}
		}
	}

	// Not authenticated — return the right error
	if (!sharedToken) {
		return {
			ok: false as const,
			response: Response.json(
				{ ok: false, error: 'MCP_SHARED_TOKEN is not configured.' },
				{ status: 503 },
			),
		};
	}

	return {
		ok: false as const,
		response: new Response(
			JSON.stringify({ ok: false, error: 'Unauthorized.' }),
			{
				status: 401,
				headers: {
					'Content-Type': 'application/json',
					'WWW-Authenticate': `Bearer realm="secondbrain", resource_metadata="${new URL('/.well-known/oauth-protected-resource', request.url).toString()}"`,
				},
			},
		),
	};
}

function renderAuthPage(clientName: string, error: string | null): Response {
	const html = `<!DOCTYPE html>
	<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>secondbrain — Authorize</title>
	<style>
		*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
		body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1rem; }
		.card { background: #fff; border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,.08); padding: 2rem; width: 100%; max-width: 380px; }
		h1 { font-size: 1.25rem; font-weight: 700; color: #111; margin-bottom: .25rem; }
		.subtitle { font-size: .875rem; color: #666; margin-bottom: 1.5rem; }
		.subtitle strong { color: #111; }
		label { display: block; font-size: .875rem; font-weight: 500; color: #333; margin-bottom: .375rem; }
		input[type=password] { width: 100%; padding: .625rem .75rem; border: 1px solid #ddd; border-radius: 8px; font-size: 1rem; outline: none; transition: border-color .15s; }
		input[type=password]:focus { border-color: #0066ff; box-shadow: 0 0 0 3px rgba(0,102,255,.12); }
		.error { background: #fff0f0; border: 1px solid #ffcdd2; border-radius: 8px; color: #c62828; font-size: .875rem; padding: .625rem .75rem; margin-bottom: 1rem; }
		button { width: 100%; padding: .75rem; background: #0066ff; color: #fff; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; margin-top: 1rem; transition: background .15s; }
		button:hover { background: #0052cc; }
	</style>
</head>
<body>
	<div class="card">
			<h1>secondbrain</h1>
			<p class="subtitle">Authorizing <strong>${htmlEscape(clientName)}</strong> to access your memories.</p>
			${error ? `<div class="error">${htmlEscape(error)}</div>` : ''}
			<form method="POST">
				<label for="password">Admin password</label>
				<input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
				<button type="submit">Authorize access</button>
		</form>
	</div>
</body>
</html>`;

	return new Response(html, {
		status: error ? 400 : 200,
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
}

async function handleOAuthRegister(request: Request, env: WorkerEnv): Promise<Response> {
	await ensureOAuthSchema(env.MEMORY_DB);

	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ error: 'invalid_request', error_description: 'Invalid JSON body.' },
			{ status: 400, headers: corsHeaders() },
			);
	}

	let redirectUris: string[];
	let name: string | null;
	try {
		redirectUris = normalizeRedirectUris(body['redirect_uris']);
		name = normalizeClientName(body['client_name']);
	} catch (error) {
		return Response.json(
			{ error: 'invalid_request', error_description: error instanceof Error ? error.message : String(error) },
			{ status: 400, headers: corsHeaders() },
		);
	}

	const clientId = generateToken(16);

	await env.MEMORY_DB
		.prepare('INSERT INTO oauth_clients (id, redirect_uris, name) VALUES (?1, ?2, ?3)')
		.bind(clientId, JSON.stringify(redirectUris), name)
		.run();

	return Response.json(
		{
			client_id: clientId,
			redirect_uris: redirectUris,
			...(name ? { client_name: name } : {}),
		},
		{ status: 201, headers: corsHeaders() },
	);
}

async function handleOAuthAuthorize(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
	await ensureOAuthSchema(env.MEMORY_DB);

	const qp = url.searchParams;
	const clientId = qp.get('client_id') ?? '';
	const redirectUri = qp.get('redirect_uri') ?? '';
	const state = qp.get('state') ?? '';
	const codeChallenge = qp.get('code_challenge') ?? '';
	const codeChallengeMethod = qp.get('code_challenge_method') ?? 'S256';

	if (qp.get('response_type') !== 'code') {
		return Response.json({ error: 'unsupported_response_type' }, { status: 400 });
	}

	if (!clientId) {
		return Response.json({ error: 'invalid_request', error_description: 'client_id is required.' }, { status: 400 });
	}

	const client = await env.MEMORY_DB
		.prepare('SELECT id, redirect_uris, name FROM oauth_clients WHERE id = ?1')
		.bind(clientId)
		.first<OAuthClientRow>();

	if (!client) {
		return Response.json({ error: 'invalid_client', error_description: 'Unknown client_id.' }, { status: 400 });
	}

	let allowedUris: string[];
	try {
		allowedUris = parseRedirectUris(client.redirect_uris);
	} catch (error) {
		return Response.json(
			{ error: 'server_error', error_description: error instanceof Error ? error.message : String(error) },
			{ status: 500 },
		);
	}

	if (redirectUri && !allowedUris.includes(redirectUri)) {
		return Response.json({ error: 'invalid_request', error_description: 'redirect_uri does not match registered URIs.' }, { status: 400 });
	}

	const finalRedirectUri = redirectUri || allowedUris[0] || '';
	if (!finalRedirectUri) {
		return Response.json({ error: 'invalid_request', error_description: 'No redirect_uri available.' }, { status: 400 });
	}

	if (!codeChallenge) {
		return Response.json({ error: 'invalid_request', error_description: 'code_challenge is required.' }, { status: 400 });
	}

	if (codeChallengeMethod !== 'S256') {
		return Response.json({ error: 'invalid_request', error_description: 'code_challenge_method must be S256.' }, { status: 400 });
	}

	if (request.method === 'POST') {
		const formData = await request.formData();
		const password = formData.get('password') as string | null;

		const sharedToken = env.MCP_SHARED_TOKEN?.trim();
		if (!sharedToken) {
			return renderAuthPage(client.name ?? clientId, 'Server is not configured. Set MCP_SHARED_TOKEN to enable login.');
		}

		if (!password || !constantTimeEqual(password, sharedToken)) {
			return renderAuthPage(client.name ?? clientId, 'Incorrect password. Try again.');
		}

		const code = generateToken(32);
		const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString();

		await env.MEMORY_DB
			.prepare('INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
			.bind(code, clientId, finalRedirectUri, codeChallenge, codeChallengeMethod, expiresAt)
			.run();

		const redirectUrl = new URL(finalRedirectUri);
		redirectUrl.searchParams.set('code', code);
		if (state) redirectUrl.searchParams.set('state', state);

		return Response.redirect(redirectUrl.toString(), 302);
	}

	return renderAuthPage(client.name ?? clientId, null);
}

async function handleOAuthToken(request: Request, env: WorkerEnv): Promise<Response> {
	await ensureOAuthSchema(env.MEMORY_DB);

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		return Response.json({ error: 'invalid_request' }, { status: 400, headers: corsHeaders() });
	}

	const getField = (name: string) => {
		const value = formData.get(name);
		return typeof value === 'string' ? value : '';
	};

	if (getField('grant_type') !== 'authorization_code') {
		return Response.json({ error: 'unsupported_grant_type' }, { status: 400, headers: corsHeaders() });
	}

	const code = getField('code');
	const clientId = getField('client_id');
	const redirectUri = getField('redirect_uri');
	const codeVerifier = getField('code_verifier');

	if (!code) {
		return Response.json({ error: 'invalid_request', error_description: 'code is required.' }, { status: 400, headers: corsHeaders() });
	}

	if (!clientId) {
		return Response.json({ error: 'invalid_request', error_description: 'client_id is required.' }, { status: 400, headers: corsHeaders() });
	}

	const codeRow = await env.MEMORY_DB
		.prepare('SELECT * FROM oauth_codes WHERE code = ?1')
		.bind(code)
		.first<OAuthCodeRow>();

	if (!codeRow) {
		return Response.json({ error: 'invalid_grant', error_description: 'Unknown or expired authorization code.' }, { status: 400, headers: corsHeaders() });
	}

	// Delete code immediately — single use
	await env.MEMORY_DB.prepare('DELETE FROM oauth_codes WHERE code = ?1').bind(code).run();

	if (new Date(codeRow.expires_at) < new Date()) {
		return Response.json({ error: 'invalid_grant', error_description: 'Authorization code has expired.' }, { status: 400, headers: corsHeaders() });
	}

	if (clientId !== codeRow.client_id) {
		return Response.json({ error: 'invalid_grant', error_description: 'client_id mismatch.' }, { status: 400, headers: corsHeaders() });
	}

	if (redirectUri && redirectUri !== codeRow.redirect_uri) {
		return Response.json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch.' }, { status: 400, headers: corsHeaders() });
	}

	// PKCE verification
	if (codeRow.code_challenge) {
		if (!codeVerifier) {
			return Response.json({ error: 'invalid_grant', error_description: 'code_verifier is required.' }, { status: 400, headers: corsHeaders() });
		}
		if (codeRow.code_challenge_method !== 'S256') {
			return Response.json({ error: 'invalid_grant', error_description: 'Unsupported code_challenge_method.' }, { status: 400, headers: corsHeaders() });
		}
		const valid = await verifyPkceChallenge(codeVerifier, codeRow.code_challenge);
		if (!valid) {
			return Response.json({ error: 'invalid_grant', error_description: 'code_verifier does not match challenge.' }, { status: 400, headers: corsHeaders() });
		}
	}

	const sharedToken = env.MCP_SHARED_TOKEN?.trim();
	if (!sharedToken) {
		return Response.json({ error: 'server_error', error_description: 'MCP_SHARED_TOKEN is not configured.' }, { status: 500, headers: corsHeaders() });
	}

	const secretFingerprint = await sha256Base64Url(sharedToken);
	const accessToken = generateToken(32);
	const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
	await env.MEMORY_DB
		.prepare('INSERT INTO oauth_tokens (token, client_id, secret_fingerprint, expires_at) VALUES (?1, ?2, ?3, ?4)')
		.bind(accessToken, codeRow.client_id, secretFingerprint, expiresAt)
		.run();

	return Response.json(
		{ access_token: accessToken, token_type: 'bearer', expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) },
		{ headers: corsHeaders() },
	);
}

async function findExistingMemoryByContent(env: WorkerEnv, namespace: string, content: string) {
	const row = await env.MEMORY_DB
		.prepare(
			`SELECT id, namespace, content, tags, source, created_at
			 FROM memories
			 WHERE namespace = ?1
			   AND content = ?2
			 LIMIT 1`,
		)
		.bind(namespace, content)
		.first<MemoryRow>();

	return row ?? null;
}

async function storeMemory(
	env: WorkerEnv,
	input: { namespace?: string; content: string; tags?: string[]; source?: string },
): Promise<StoredMemoryResult> {
	await ensureSchema(env.MEMORY_DB);

	const id = crypto.randomUUID();
	const normalizedNamespace = validateNamespace(input.namespace);
	const normalizedTags = normalizeTags(input.tags);
	const normalizedTagString = normalizedTags.join(',');
	const trimmedContent = normalizeContent(input.content);
	const trimmedSource = normalizeSource(input.source);

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
		ok: true,
		id,
		namespace: normalizedNamespace,
		tags: normalizedTags,
		semanticIndexed,
		...(warning ? { warning } : {}),
	};
}

async function autoRemember(
	env: WorkerEnv,
	input: {
		namespace?: string;
		text: string;
		tags?: string[];
		source?: string;
		maxItems?: number;
		dryRun?: boolean;
	},
) {
	await ensureSchema(env.MEMORY_DB);

	const normalizedNamespace = validateNamespace(input.namespace);
	const normalizedText = normalizeAutoRememberText(input.text);
	const normalizedSource = normalizeSource(input.source) ?? undefined;
	const baseTags = normalizeTags(input.tags);
	const safeMaxItems = normalizeAutoRememberItems(input.maxItems);
	const candidates = extractAutoRememberCandidates(normalizedText, safeMaxItems);

	if (input.dryRun) {
		return {
			ok: true,
			dryRun: true,
			namespace: normalizedNamespace,
			count: candidates.length,
			items: candidates.map((candidate) => ({
				content: candidate.content,
				tags: normalizeTags([...baseTags, ...candidate.tags]),
				score: candidate.score,
				reason: candidate.reason,
			})),
		};
	}

	const saved: Array<StoredMemoryResult & { content: string; reason: string }> = [];
	const skipped: Array<{ content: string; reason: string; existingId?: string }> = [];

	for (const candidate of candidates) {
		const existing = await findExistingMemoryByContent(env, normalizedNamespace, candidate.content);
		if (existing) {
			skipped.push({
				content: candidate.content,
				reason: 'duplicate',
				existingId: existing.id,
			});
			continue;
		}

		const stored = await storeMemory(env, {
			namespace: normalizedNamespace,
			content: candidate.content,
			tags: [...baseTags, ...candidate.tags],
			source: normalizedSource,
		});

		saved.push({
			...stored,
			content: candidate.content,
			reason: candidate.reason,
		});
	}

	return {
		ok: true,
		namespace: normalizedNamespace,
		analyzed: candidates.length,
		savedCount: saved.length,
		skippedCount: skipped.length,
		saved,
		skipped,
	};
}

function createServer(env: WorkerEnv) {
	const server = new McpServer({
		name: 'cloudflare-memory-mcp',
		version: '0.1.0',
	});

	server.registerTool(
		'auto_remember',
		{
			title: 'Capture durable memory from conversation',
			description:
				'Preferred memory-writing tool for chat clients. Use this when the user shares durable preferences, identity details, goals, constraints, or ongoing project facts in raw conversation text. Pass the relevant excerpt in text. Set dryRun=true to preview before saving.',
			inputSchema: {
				namespace: z.string().optional(),
				text: z.string().min(1),
				tags: z.array(z.string()).optional(),
				source: z.string().optional(),
				maxItems: z.number().int().min(1).max(MAX_AUTO_REMEMBER_ITEMS).optional(),
				dryRun: z.boolean().optional(),
			},
			annotations: {
				title: 'Preferred conversation memory capture',
			},
		},
		async ({ namespace, text, tags, source, maxItems, dryRun }) => {
			const result = await autoRemember(env, { namespace, text, tags, source, maxItems, dryRun });
			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							result,
							null,
							2,
						),
					},
				],
			};
		},
	);

	server.registerTool(
		'remember',
		{
			title: 'Save one explicit memory',
			description:
				'Use this when you already have a single memory distilled to one clear fact. For raw chat transcripts or when multiple durable facts may be present, prefer auto_remember instead.',
			inputSchema: {
				namespace: z.string().optional(),
				content: z.string().min(1),
				tags: z.array(z.string()).optional(),
				source: z.string().optional(),
			},
			annotations: {
				title: 'Single memory write',
			},
		},
		async ({ namespace, content, tags, source }) => {
			const stored = await storeMemory(env, { namespace, content, tags, source });

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(
							stored,
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

export const internals = {
	extractAutoRememberCandidates,
	autoRemember,
};

export default {
	async fetch(request, env: WorkerEnv, ctx): Promise<Response> {
		const url = new URL(request.url);

		// Handle CORS preflight for OAuth endpoints
		if (request.method === 'OPTIONS') {
			const oauthPaths = ['/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token'];
			if (oauthPaths.includes(url.pathname)) {
				return new Response(null, { status: 204, headers: corsHeaders() });
			}
		}

		if (url.pathname === '/.well-known/oauth-authorization-server') {
			const base = getBaseUrl(url);
			return Response.json(
				{
					issuer: base,
					authorization_endpoint: `${base}/oauth/authorize`,
					token_endpoint: `${base}/oauth/token`,
					registration_endpoint: `${base}/oauth/register`,
					response_types_supported: ['code'],
					grant_types_supported: ['authorization_code'],
					code_challenge_methods_supported: ['S256'],
					token_endpoint_auth_methods_supported: ['none'],
				},
				{ headers: corsHeaders() },
			);
		}

		if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
			return Response.json(getProtectedResourceMetadata(url), { headers: corsHeaders() });
		}

		if (url.pathname === '/oauth/register' && request.method === 'POST') {
			return handleOAuthRegister(request, env);
		}

		if (url.pathname === '/oauth/authorize' && (request.method === 'GET' || request.method === 'POST')) {
			return handleOAuthAuthorize(request, env, url);
		}

		if (url.pathname === '/oauth/token' && request.method === 'POST') {
			return handleOAuthToken(request, env);
		}

		if (url.pathname === '/mcp') {
			if (request.method !== 'OPTIONS') {
				const auth = await authorizeRequest(request, env);
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
					tools: ['auto_remember', 'remember', 'recall', 'forget', 'list_namespaces'],
					note: 'Shared memory is hybrid: D1 stores canonical records and Vectorize handles semantic recall. auto_remember is the preferred write tool for raw conversation text.',
				});
			}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<WorkerEnv>;
