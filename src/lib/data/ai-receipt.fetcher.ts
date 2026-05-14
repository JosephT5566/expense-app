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

export async function getUploadUrl(files: { file_name: string; content_type: string }[]) {
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

	const response = await fetch(PUBLIC_GOOGLE_AI_GCF, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			action: 'get_upload_url',
			files
		})
	});

	if (!response.ok) {
		throw new Error(`Failed to get upload URL: ${response.statusText}`);
	}

	return (await response.json()) as {
		uploads: {
			file_name: string;
			upload_url: string;
			file_path: string;
		}[];
	};
}

export async function analyzeReceipt(filePaths: string[]) {
	const accessToken = await getAccessToken();

	Logger.log('Triggering AI analysis for:', filePaths);
	const response = await fetch(PUBLIC_GOOGLE_AI_GCF, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			action: 'analyze_receipt',
			file_paths: filePaths
		})
	});

	if (!response.ok) {
		throw new Error(`Failed to analyze receipt: ${response.statusText}`);
	}

	const data = await response.json();
	return data;
}
