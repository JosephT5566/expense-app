import { writable } from 'svelte/store';
import type { AppUser } from '$lib/types/user';
import { supabase } from '$lib/supabase/supabaseClient';

function createSessionStore() {
	const user = writable<AppUser | null>(null);
	const loading = writable(true);

	async function init() {
		const { data } = await supabase.auth.getUser();
		if (data.user) {
			user.set({
				id: data.user.id,
				email: data.user.email ?? '',
				display_name: data.user.user_metadata?.name ?? null,
				photo_url: data.user.user_metadata?.avatar_url ?? null,
			});
		} else {
			user.set(null);
		}
		loading.set(false);

		supabase.auth.onAuthStateChange(async (_event, session) => {
			if (session?.user) {
				user.set({
					id: session.user.id,
					email: session.user.email ?? '',
					display_name: session.user.user_metadata?.name ?? null,
					photo_url: session.user.user_metadata?.avatar_url ?? null,
				});
			} else {
				user.set(null);
			}
		});
	}

	return { user, loading, init };
}

export const sessionStore = createSessionStore();
