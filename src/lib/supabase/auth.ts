import { supabase } from '$lib/supabase/supabaseClient';
import {
	loading as sessionLoading,
	reset as resetUser,
	setFromLoad as setUser,
	user as currentUser,
} from '$lib/stores/session.store';
import { base } from '$app/paths';
import { page } from '$app/state';

const SIGN_IN_AT_KEY = 'expense-app:sign-in-at';
const SIGN_IN_TTL_KEY = 'expense-app:sign-in-ttl';

export const DEFAULT_AUTO_SIGN_OUT_MS = 1000 * 60 * 60 * 8; // eight hours

interface StoredSignInInfo {
	signedInAt: number;
	ttlMs: number;
}

/**
 * Persists the current sign-in timestamp and optional TTL so we can later decide
 * whether the session is stale. No-op on the server.
 *
 * @param durationMs - Maximum age (milliseconds) before the session is considered expired.
 */
export function persistSignInTimestamp(durationMs = DEFAULT_AUTO_SIGN_OUT_MS) {
	if (typeof window === 'undefined') {
		return;
	}
	const storage = window.localStorage;
	const now = Date.now();
	storage.setItem(SIGN_IN_AT_KEY, `${now}`);
	storage.setItem(SIGN_IN_TTL_KEY, `${durationMs}`);
}

/**
 * Removes any stored sign-in metadata from localStorage. No-op on the server.
 */
export function clearSignInTracking() {
	if (typeof window === 'undefined') {
		return;
	}
	const storage = window.localStorage;
	storage.removeItem(SIGN_IN_AT_KEY);
	storage.removeItem(SIGN_IN_TTL_KEY);
}

/**
 * Reads the stored sign-in metadata, normalising corrupt entries when necessary.
 *
 * @returns The stored timestamp/TTL pair, or `null` when not available.
 */
export function getStoredSignInInfo(): StoredSignInInfo | null {
	if (typeof window === 'undefined') {
		return null;
	}
	const storage = window.localStorage;
	const signedInAtStr = storage.getItem(SIGN_IN_AT_KEY);
	if (!signedInAtStr) {
		return null;
	}

	const signedInAt = Number.parseInt(signedInAtStr, 10);
	if (!Number.isFinite(signedInAt)) {
		clearSignInTracking();
		return null;
	}

	const ttlStr = storage.getItem(SIGN_IN_TTL_KEY);
	const ttlMs = ttlStr ? Number.parseInt(ttlStr, 10) : DEFAULT_AUTO_SIGN_OUT_MS;

	return {
		signedInAt,
		ttlMs: Number.isFinite(ttlMs) ? ttlMs : DEFAULT_AUTO_SIGN_OUT_MS,
	};
}

/**
 * Determines whether the stored session has exceeded its allowed TTL.
 *
 * @param durationOverrideMs - Optional override that supersedes the stored TTL.
 * @returns `true` if the session has expired, otherwise `false`.
 */
export function isStoredSessionExpired(durationOverrideMs?: number) {
	const info = getStoredSignInInfo();
	if (!info) {
		return false;
	}

	const ttlMs = durationOverrideMs ?? info.ttlMs ?? DEFAULT_AUTO_SIGN_OUT_MS;
	const expiresAt = info.signedInAt + ttlMs;
	return Date.now() >= expiresAt;
}

export function startAuthListener() {
	// Events are emitted across tabs to keep application's UI up-to-date
	const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
		// note:
		// Once we sign in/page loaded, event = INITIAL_SESSION.
		// If the page is focused again, event = SIGNED_IN.
		// Once we click on Sign Out button, event will be changed to SIGNED_OUT
		if (event === 'SIGNED_OUT' || !session?.user) {
			// is logged out
			clearSignInTracking();
			resetUser();
		}

		if (session?.user && !currentUser) {
			const u = session.user;
			setUser({
				id: u.id,
				email: u.email ?? '',
				display_name: u.user_metadata?.name ?? null,
				photo_url: u.user_metadata?.avatar_url ?? null,
			});
		}
	});
	return () => sub.subscription.unsubscribe();
}

/**
 * Signs the current user out if the session is expired.
 *
 * @param durationOverrideMs - Optional override that supersedes the stored TTL.
 * @returns Resolves to `true` when a sign-out occurred, otherwise `false`.
 */
export async function signOutIfExpired(durationOverrideMs?: number) {
	if (typeof window === 'undefined') {
		return false;
	}
	if (!isStoredSessionExpired(durationOverrideMs)) {
		return false;
	}
	await signOut();
	return true;
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
		options: { redirectTo },
	});

	const autoSignOutMs = DEFAULT_AUTO_SIGN_OUT_MS;
	persistSignInTimestamp(autoSignOutMs);

	sessionLoading.set(false);
}

/**
 * Signs the user out and clears any stored sign-in metadata.
 */
export async function signOut() {
	clearSignInTracking();
	sessionLoading.set(true);
	await supabase.auth.signOut();
	sessionLoading.set(false);
}
