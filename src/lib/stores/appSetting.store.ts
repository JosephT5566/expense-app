import { user } from '$lib/stores/session.store';
import { writable, derived } from 'svelte/store';
import { PUBLIC_EMAIL_NAME_MAPPING } from '$env/static/public';

export const allowedUsers = writable<string[]>([]);
export const loading = writable(true);
export function setFromLoad(allowedEmails: string[]) {
	allowedUsers.set(allowedEmails);
	loading.set(false);
}

export const allowedUserNames = derived([allowedUsers, user], ([allowed, me]) => {
	const emailNameMapping = JSON.parse(PUBLIC_EMAIL_NAME_MAPPING);
	const map: Record<string, string> = {};
	for (const email of allowed) {
		if (emailNameMapping?.[email]) {
			map[email] = emailNameMapping[email];
		} else if (me?.email === email && me.display_name) {
			map[email] = me.display_name;
		} else {
			map[email] = email.split('@')[0]; // 預設用 email 前綴
		}
	}
	return map;
});
