import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			remoteBindings: false,
			miniflare: {
				serviceBindings: {
					BUDGET_GUARD: async () => Response.json({ allowed: true }),
				},
			},
		}),
	],
	test: {
	},
});
