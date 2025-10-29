import { writable } from 'svelte/store';
import type { AppUser } from '$lib/types/user';
import { supabase } from '$lib/supabase/supabaseClient';
import {
	clearSignInTracking,
	getStoredSignInInfo,
	persistSignInTimestamp,
	DEFAULT_AUTO_SIGN_OUT_MS,
} from '$lib/supabase/auth';

export const user = writable<AppUser | null>(null);
export const loading = writable(true);

export function setFromLoad(u: AppUser | null) {
	user.set(u);
	loading.set(false);
}

export function startAuthListener(opts?: {
	onLogin?: (params: { user: { id: string; email: string } }) => Promise<void> | void;
	onLogout?: () => Promise<void> | void;
	autoSignOutMs?: number;
}) {
	const autoSignOutMs = opts?.autoSignOutMs ?? DEFAULT_AUTO_SIGN_OUT_MS;

	const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
		const event = _event;

		if (session?.user) {
			// is logged in
			if (event === 'SIGNED_IN') {
				persistSignInTimestamp(autoSignOutMs);
			} else if (!getStoredSignInInfo()) {
				persistSignInTimestamp(autoSignOutMs);
			}

			const u = session.user;
			user.set({
				id: u.id,
				email: u.email ?? '',
				display_name: u.user_metadata?.name ?? null,
				photo_url: u.user_metadata?.avatar_url ?? null,
			});

			// callback login handler
			await opts?.onLogin?.({ user: { id: u.id, email: u.email ?? '' } });
		} else {
			// is logged out
			clearSignInTracking();
			reset();

			// callback logout handler
			await opts?.onLogout?.();
		}
	});
	return () => sub.subscription.unsubscribe();
}

export function reset() {
	user.set(null);
}
