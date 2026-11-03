import { defineConfig } from '@playwright/test';

export const BASE_PATH_ORIGIN = 'http://localhost:4174';
const previewUrl = new URL(BASE_PATH_ORIGIN);

export default defineConfig({
	webServer: {
		command: `BASE_PATH=/expense-app npm run build && BASE_PATH=/expense-app npm run preview -- --host ${previewUrl.hostname} --port ${previewUrl.port} --strictPort`,
		url: `${BASE_PATH_ORIGIN}/expense-app/`,
		timeout: 180_000,
		reuseExistingServer: false
	},
	use: { baseURL: BASE_PATH_ORIGIN },
	testDir: 'e2e-base-path'
});
