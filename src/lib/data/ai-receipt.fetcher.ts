import { PUBLIC_GOOGLE_AI_GCF } from '$env/static/public';
import { supabase } from '$lib/supabase/supabaseClient';
import Logger from '$lib/utils/logger';

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
