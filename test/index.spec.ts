import { createExecutionContext, env, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

type TestEnv = typeof env & {
	MCP_SHARED_TOKEN?: string;
	ALLOW_UNAUTHENTICATED?: string;
};

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
		await expect(response.json()).resolves.toMatchObject({
			ok: false,
			error: 'Unauthorized.',
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
