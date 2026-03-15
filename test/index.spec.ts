import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';

describe('cloudflare-memory-mcp worker', () => {
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

	it('returns service metadata at / (integration style)', async () => {
		const response = await SELF.fetch('http://example.com/');
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			tools: ['remember', 'recall', 'forget', 'list_namespaces'],
		});
	});
});
