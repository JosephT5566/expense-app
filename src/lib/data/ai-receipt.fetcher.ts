import { PUBLIC_GOOGLE_AI_GCF } from '$env/static/public';
import { supabase } from '$lib/supabase/supabaseClient';
import Logger from '$lib/utils/logger';
import type { ReceiptAnalysisResult } from '$lib/types/expense';

export interface AnalyzeReceiptResponse {
	action: 'analyze_receipt';
	status: 'success';
	result: ReceiptAnalysisResult;
}

export class AIReceiptAPIError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: string
	) {
		super(message);
		this.name = 'AIReceiptAPIError';
	}
}

export function getAnalyzeReceiptErrorMessage(error: unknown): string {
	if (error instanceof AIReceiptAPIError && error.code === 'INVALID_MODEL_OUTPUT') {
		return 'AI 回傳的收據資料格式無效，請重新分析或改用另一張圖片。';
	}
	if (error instanceof AIReceiptAPIError) {
		return error.message || '分析收據時發生錯誤。';
	}
	return '分析收據時發生錯誤，請稍後再試。';
}

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
		let errorCode: string | undefined;
		let errorMessage = response.statusText;
		try {
			const body = (await response.json()) as {
				code?: string;
				message?: string;
				error?: { code?: string; message?: string };
			};
			errorCode = body.error?.code ?? body.code;
			errorMessage = body.error?.message ?? body.message ?? errorMessage;
		} catch {
			// The status information remains useful if the error body is not JSON.
		}
		throw new AIReceiptAPIError(
			errorMessage || `Failed to analyze receipt (${response.status})`,
			response.status,
			errorCode
		);
	}

	return (await response.json()) as AnalyzeReceiptResponse;
}
