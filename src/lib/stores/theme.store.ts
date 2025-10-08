import { writable } from 'svelte/store';
export type ThemeName = 'sunset' | 'moss';
export const theme = writable<ThemeName>('sunset');

// Side effect: apply to <html>
theme.subscribe((t) => {
	if (typeof document !== 'undefined') {
		document.documentElement.setAttribute('data-theme', t);
	}
});
