import { defineConfig } from '@playwright/test';

export default defineConfig({
	webServer: {
		command:
			'BASE_PATH=/expense-app npm run build && BASE_PATH=/expense-app npm run preview -- --host localhost --port 4174 --strictPort',
		url: 'http://localhost:4174/expense-app/',
		timeout: 180_000,
		reuseExistingServer: false
	},
	use: { baseURL: 'http://localhost:4174' },
	testDir: 'e2e-base-path'
});
