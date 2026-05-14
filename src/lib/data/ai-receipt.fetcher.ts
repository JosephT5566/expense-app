import { PUBLIC_GOOGLE_AI_GCF, PUBLIC_SUPABASE_URL } from '$env/static/public';
import { supabase } from '$lib/supabase/supabaseClient';
import Logger from '$lib/utils/logger';
import * as jose from 'jose';

async function getAccessToken() {
	const {
		data: { session }
	} = await supabase.auth.getSession();
	const accessToken = session?.access_token;
	if (!accessToken) {
		throw new Error('No access token found');
	}
	return accessToken;
}

export async function getUploadUrl(fileName: string, contentType: string) {
	const accessToken = await getAccessToken();

	try {
		const JWKS = jose.createRemoteJWKSet(
			new URL(`${PUBLIC_SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
		);
		await jose.jwtVerify(accessToken, JWKS);
	} catch (error) {
		Logger.error('Token verification failed:', error);
		throw error;
	}

	const url = new URL(PUBLIC_GOOGLE_AI_GCF);
	url.searchParams.set('action', 'get_upload_url');
	url.searchParams.set('file_name', fileName);
	url.searchParams.set('content_type', contentType);

	const response = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${accessToken}`
		}
	});

	if (!response.ok) {
		throw new Error(`Failed to get upload URL: ${response.statusText}`);
	}

	return await response.json();
}

export async function analyzeReceipt(filePath: string) {
	const accessToken = await getAccessToken();

	const url = new URL(PUBLIC_GOOGLE_AI_GCF);
	url.searchParams.set('action', 'analyze_receipt');
	url.searchParams.set('file_path', filePath);

	Logger.log('Triggering AI analysis for:', filePath);
	const response = await fetch(url.toString(), {
		headers: {
			Authorization: `Bearer ${accessToken}`
		}
	});

	if (!response.ok) {
		throw new Error(`Failed to analyze receipt: ${response.statusText}`);
	}

	const data = await response.json();
	return data;
}
