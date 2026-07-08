import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { sentrySvelteKit } from '@sentry/sveltekit';

export default defineConfig({
	optimizeDeps: {
		exclude: ['@internationalized/date']
	},
	plugins: [
		await sentrySvelteKit({
			org: 'josephtseng',
			project: 'expense-app',
			telemetry: false
		}),
		tailwindcss(),
		sveltekit(),
		SvelteKitPWA({
			registerType: 'prompt',
			manifest: {
				name: 'JoPie',
				short_name: 'JoPie',
				description:
					'A simple expense tracking app for Joseph and Pieda. And JoPie sounds like tshiau-phài.',
				theme_color: '#ffffff',
				icons: [
					{
						src: 'icon-192.png',
						sizes: '192x192',
						type: 'image/png'
					},
					{
						src: 'icon-512.png',
						sizes: '512x512',
						type: 'image/png'
					},
					{
						src: 'icon-512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'any maskable'
					}
				]
			}
		})
	]
});
