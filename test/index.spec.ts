import { createExecutionContext, env, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

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
