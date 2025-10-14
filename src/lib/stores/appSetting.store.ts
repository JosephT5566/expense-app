import { writable } from 'svelte/store';

export const allowedUsers = writable<string[]>([]);
export const loading = writable(true);
export function setFromLoad(allowedEmails: string[]) {
	allowedUsers.set(allowedEmails);
	loading.set(false);
}
