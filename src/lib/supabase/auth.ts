import { supabase } from '$lib/supabase/supabaseClient';
import {
	loading as sessionLoading,
	reset as resetUser,
	setFromLoad as setUser
} from '$lib/stores/session.store';
import { base } from '$app/paths';
import { page } from '$app/state';

export function startAuthListener() {
	// Events are emitted across tabs to keep application's UI up-to-date
	const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
		// note:
		// Once we sign in/page loaded, event = INITIAL_SESSION.
		// If the page is focused again, event = SIGNED_IN.
		// Once we click on Sign Out button, event will be changed to SIGNED_OUT
		if (event === 'SIGNED_OUT' || !session?.user) {
			// is logged out
			resetUser();
			return;
		}

		const u = session.user;
		setUser({
			id: u.id,
			email: u.email ?? '',
			display_name: u.user_metadata?.name ?? null,
			photo_url: u.user_metadata?.avatar_url ?? null
		});
	});
	return () => sub.subscription.unsubscribe();
}

/**
 * Wrapper around Supabase OAuth sign-in to keep auth helpers colocated.
 * The URL in redirectTo should match the Redirect URLs list configuration.
 * (https://supabase.com/dashboard/project/_/auth/url-configuration)
 */
export async function signIn() {
	const pageUrl = page.url;
	const redirectTo = `${pageUrl.origin}${base}/`;

	sessionLoading.set(true);
	await supabase.auth.signInWithOAuth({
		provider: 'google',
		options: {
			redirectTo,
			queryParams: {
				prompt: 'select_account'
			}
		}
	});

	sessionLoading.set(false);
}

/**
 * Signs the user out and clears any stored sign-in metadata.
 */
export async function signOut() {
	sessionLoading.set(true);
	await supabase.auth.signOut();
	sessionLoading.set(false);
}
