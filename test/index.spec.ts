import { createExecutionContext, env, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { internals } from '../src';

type TestEnv = typeof env & {
	MCP_SHARED_TOKEN?: string;
	ALLOW_UNAUTHENTICATED?: string;
};

function createMemoryTestEnv() {
	return {
		...env,
		MCP_SHARED_TOKEN: 'top-secret',
		AI: {
			run: async () => ({
				data: [[0.1, 0.2, 0.3]],
			}),
		},
		MEMORY_INDEX: {
			upsert: async () => undefined,
			deleteByIds: async () => undefined,
			query: async () => ({ matches: [] }),
			describe: async () => ({ dimensions: 3, vectorsCount: 0 }),
		},
	} as TestEnv;
}

async function sha256Base64Url(value: string) {
	const data = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');
}

async function fetchWithEnv(url: string, init: RequestInit = {}, customEnv: TestEnv = env) {
	const request = new Request<unknown, IncomingRequestCfProperties>(url, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, customEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function listTools(customEnv: TestEnv) {
	const response = await fetchWithEnv(
		'http://example.com/mcp',
		{
			method: 'POST',
			headers: {
				Accept: 'application/json, text/event-stream',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${customEnv.MCP_SHARED_TOKEN ?? ''}`,
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		},
		customEnv,
	);

	const contentType = response.headers.get('content-type') ?? '';
	const rawBody = await response.text();
	let parsedBody: {
		result?: {
			tools?: Array<{
				name: string;
				title?: string;
				description?: string;
				annotations?: {
					title?: string;
				};
			}>;
		};
	} | undefined;

	if (contentType.includes('text/event-stream')) {
		const eventPayloads = rawBody
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trim())
			.filter(Boolean);

		for (const payload of eventPayloads) {
			try {
				const candidate = JSON.parse(payload) as typeof parsedBody;
				if (candidate?.result?.tools) {
					parsedBody = candidate;
					break;
				}
			} catch {
				// Ignore non-JSON event payloads while scanning the stream.
			}
		}
	} else if (rawBody.trim()) {
		parsedBody = JSON.parse(rawBody) as typeof parsedBody;
	}

	return {
		status: response.status,
		body: parsedBody,
	};
}

describe('cloudflare-memory-mcp worker', () => {
	it('requires bearer auth for /mcp when a shared token is configured', async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/mcp', {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			request,
			{ ...env, MCP_SHARED_TOKEN: 'top-secret' },
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		expect(response.headers.get('WWW-Authenticate')).toContain('/.well-known/oauth-protected-resource');
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: 'Unauthorized.',
		});
	});

	it('serves OAuth protected-resource metadata for MCP discovery', async () => {
		const response = await fetchWithEnv('http://example.com/.well-known/oauth-protected-resource');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			resource: 'http://example.com/mcp',
			authorization_servers: ['http://example.com'],
			bearer_methods_supported: ['header'],
		});
	});

	it('serves path-specific OAuth protected-resource metadata for MCP discovery', async () => {
		const response = await fetchWithEnv('http://example.com/.well-known/oauth-protected-resource/mcp');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			resource: 'http://example.com/mcp',
			authorization_servers: ['http://example.com'],
		});
	});

	it('rejects insecure redirect URIs during dynamic client registration', async () => {
		const response = await fetchWithEnv(
			'http://example.com/oauth/register',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					redirect_uris: ['http://evil.example/callback'],
					client_name: 'Bad Client',
				}),
			},
			{ ...env, MCP_SHARED_TOKEN: 'top-secret' },
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'invalid_request',
		});
	});

	it('advertises auto_remember in service metadata', async () => {
		const response = await fetchWithEnv('http://example.com/');
		await expect(response.json()).resolves.toMatchObject({
			tools: expect.arrayContaining(['lookup_memory', 'auto_remember']),
		});
	});

	it('marks lookup_memory as the preferred read tool in tools/list', async () => {
		const { status, body } = await listTools({ ...env, MCP_SHARED_TOKEN: 'top-secret' });

		expect(status).toBe(200);
		const tools = body.result?.tools ?? [];
		expect(tools[0]?.name).toBe('lookup_memory');
		expect(tools.find((tool) => tool.name === 'lookup_memory')).toMatchObject({
			title: 'Check saved memory before answering',
			annotations: {
				title: 'Preferred memory lookup',
			},
		});
		expect(tools.find((tool) => tool.name === 'lookup_memory')?.description).toContain(
			'Preferred memory lookup tool for chat clients',
		);
		expect(tools.find((tool) => tool.name === 'recall')?.description).toContain(
			'prefer lookup_memory',
		);
		expect(tools.find((tool) => tool.name === 'auto_remember')?.description).toContain(
			'Preferred memory-writing tool for chat clients',
		);
	});

	it('auto_remember previews likely memories without storing them in dry-run mode', async () => {
		const sharedEnv = createMemoryTestEnv();
		const result = await internals.autoRemember(sharedEnv, {
			text: `Call me Kyle.\nI prefer concise answers.\nThanks!`,
			dryRun: true,
			maxItems: 3,
		});

		expect(result).toMatchObject({
			ok: true,
			dryRun: true,
			count: 2,
		});
		expect(result.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					content: 'Call me Kyle.',
				}),
				expect.objectContaining({
					content: 'I prefer concise answers.',
				}),
			]),
		);
	});

	it('auto_remember stores extracted memories and skips exact duplicates', async () => {
		const sharedEnv = createMemoryTestEnv();
		const conversation = `Call me Kyle.\nI prefer concise answers.\nI am working on secondbrain.\nOkay.`;

		const firstRun = await internals.autoRemember(sharedEnv, {
			text: conversation,
			namespace: 'profile',
			source: 'chat:test',
			maxItems: 4,
		});

		expect(firstRun).toMatchObject({
			ok: true,
			namespace: 'profile',
			savedCount: 3,
			skippedCount: 0,
		});

		const secondRun = await internals.autoRemember(sharedEnv, {
			text: conversation,
			namespace: 'profile',
			source: 'chat:test',
			maxItems: 4,
		});

		expect(secondRun).toMatchObject({
			ok: true,
			namespace: 'profile',
			savedCount: 0,
			skippedCount: 3,
		});

		const storedRows = await sharedEnv.MEMORY_DB
			.prepare('SELECT namespace, content FROM memories WHERE namespace = ?1 ORDER BY content ASC')
			.bind('profile')
			.all<{ namespace: string; content: string }>();

		expect(storedRows.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ namespace: 'profile', content: 'Call me Kyle.' }),
				expect.objectContaining({ namespace: 'profile', content: 'I prefer concise answers.' }),
				expect.objectContaining({ namespace: 'profile', content: 'I am working on secondbrain.' }),
			]),
		);
	});

	it('uses the validated authorize request values and invalidates oauth tokens after password rotation', async () => {
		const sharedEnv = { ...env, MCP_SHARED_TOKEN: 'top-secret' };
		const redirectUri = 'https://client.example/callback';
		const verifier = 'verifier-value-for-tests-0123456789';
		const challenge = await sha256Base64Url(verifier);

		const registerResponse = await fetchWithEnv(
			'http://example.com/oauth/register',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					redirect_uris: [redirectUri],
					client_name: 'Good Client',
				}),
			},
			sharedEnv,
		);

		expect(registerResponse.status).toBe(201);
		const registration = await registerResponse.json() as { client_id: string };
		expect(registration.client_id).toBeTruthy();

		const authorizeResponse = await fetchWithEnv(
			`http://example.com/oauth/authorize?response_type=code&client_id=${encodeURIComponent(registration.client_id)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=xyz&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					password: 'top-secret',
					client_id: 'tampered-client',
					redirect_uri: 'https://evil.example/callback',
					code_challenge: 'tampered-challenge',
					code_challenge_method: 'plain',
				}).toString(),
				redirect: 'manual',
			},
			sharedEnv,
		);

		expect(authorizeResponse.status).toBe(302);
		const location = authorizeResponse.headers.get('Location');
		expect(location).toBeTruthy();
		const redirectUrl = new URL(location!);
		expect(`${redirectUrl.origin}${redirectUrl.pathname}`).toBe(redirectUri);
		expect(redirectUrl.searchParams.get('state')).toBe('xyz');
		const code = redirectUrl.searchParams.get('code');
		expect(code).toBeTruthy();

		const tokenResponse = await fetchWithEnv(
			'http://example.com/oauth/token',
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					client_id: registration.client_id,
					code: code!,
					redirect_uri: redirectUri,
					code_verifier: verifier,
				}).toString(),
			},
			sharedEnv,
		);

		expect(tokenResponse.status).toBe(200);
		const tokenPayload = await tokenResponse.json() as { access_token: string; token_type: string };
		expect(tokenPayload.token_type).toBe('bearer');
		expect(tokenPayload.access_token).toBeTruthy();

		const mcpRequest = {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${tokenPayload.access_token}`,
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
		} satisfies RequestInit;

		const authorizedResponse = await fetchWithEnv('http://example.com/mcp', mcpRequest, sharedEnv);
		expect(authorizedResponse.status).not.toBe(401);

		const rotatedResponse = await fetchWithEnv(
			'http://example.com/mcp',
			mcpRequest,
			{ ...sharedEnv, MCP_SHARED_TOKEN: 'rotated-secret' },
		);
		expect(rotatedResponse.status).toBe(401);
	});

	it('returns service metadata at / (unit style)', async () => {
		const request = new Request<unknown, IncomingRequestCfProperties>('http://example.com/');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			name: 'cloudflare-memory-mcp',
			endpoint: '/mcp',
		});
	});

	it('returns 404 for unknown routes', async () => {
		const response = await SELF.fetch('http://example.com/nope');
		expect(response.status).toBe(404);
	});
});
