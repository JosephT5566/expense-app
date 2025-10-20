import { user } from '$lib/stores/session.store';
import { writable, derived } from 'svelte/store';
import { PUBLIC_EMAIL_NAME_MAPPING } from '$env/static/public';

export const allowedUsers = writable<string[]>([]);
export const loading = writable(true);
export function setFromLoad(allowedEmails: string[]) {
	allowedUsers.set(allowedEmails);
	loading.set(false);
}

export const allowedUserInfo = derived([allowedUsers, user], ([allowed, me]) => {
	const emailNameMapping = JSON.parse(PUBLIC_EMAIL_NAME_MAPPING) as Record<
		string,
		{
			name: string;
			color: string;
		}
	>;

	const info: Record<
		string,
		{
			name: string;
			color: string | null;
		}
	> = {};
	for (const email of allowed) {
		let userName = null;
		if (emailNameMapping?.[email]) {
			userName = emailNameMapping[email].name;
		} else if (me?.email === email && me.display_name) {
			userName = me.display_name;
		} else {
			userName = email.split('@')[0]; // 預設用 email 前綴
		}
		info[email] = {
			name: userName,
			color: emailNameMapping?.[email]?.color || null,
		};
	}
	return info;
});

export const getUserInfo = (email: string): { name: string; color: string } => {
	const emailNameMapping = JSON.parse(PUBLIC_EMAIL_NAME_MAPPING) as {
		email: string;
		name: string;
		color: string;
	}[];

	const matchedEmail = emailNameMapping.find((m) => m.email === email);

	const name = matchedEmail ? matchedEmail.name : email.split('@')[0];

	return {
		name,
		color: '',
	};
};
