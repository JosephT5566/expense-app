import { writable } from 'svelte/store';
import type { AppUser } from '$lib/types/user';
import { supabase } from '$lib/supabase/supabaseClient';

export const user = writable<AppUser | null>(null);
export const loading = writable(true);

export function setFromLoad(u: AppUser | null) {
	user.set(u);
	loading.set(false);
}

export function startAuthListener(opts?: {
	onLogin?: (params: { user: { id: string; email: string } }) => Promise<void> | void;
	onLogout?: () => Promise<void> | void;
}) {
	const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
		if (session?.user) {
			const u = session.user;
			user.set({
				id: u.id,
				email: u.email ?? '',
				display_name: u.user_metadata?.name ?? null,
				photo_url: u.user_metadata?.avatar_url ?? null,
			});
			await opts?.onLogin?.({ user: { id: u.id, email: u.email ?? '' } });
		} else {
			reset();
			await opts?.onLogout?.();
		}
	});
	return () => sub.subscription.unsubscribe();
}

export function reset() {
	user.set(null);
}
