import { writable } from 'svelte/store';
import type { AppUser } from '$lib/types/user';

export const user = writable<AppUser | null>(null);
export const loading = writable(true);

export function setFromLoad(u: AppUser | null) {
	user.set(u);
	loading.set(false);
}

export function reset() {
	user.set(null);
}
