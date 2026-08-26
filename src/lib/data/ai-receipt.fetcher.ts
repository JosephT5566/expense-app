import { PUBLIC_GOOGLE_AI_GCF } from '$env/static/public';
import { supabase } from '$lib/supabase/supabaseClient';
import Logger from '$lib/utils/logger';
import type { ExtractionValue, ReceiptAnalysisResult, ReceiptLineItem } from '$lib/types/expense';

export type ReceiptAnalysisStatus =
	| 'auto_acceptable'
	| 'needs_review'
	| 'invalid'
	| 'retryable_failure';

export type RecognitionStatus = 'recognized' | 'unrecognized' | 'missing' | 'explicit_null';

export type ReceiptWarningCode =
	| 'FIELD_MISSING'
	| 'FIELD_EXPLICIT_NULL'
	| 'FIELD_UNRECOGNIZED'
	| 'MISSING_CONFIDENCE'
	| 'LOW_CONFIDENCE'
	| 'NOT_A_RECEIPT'
	| 'INVALID_MODEL_OUTPUT'
	| 'PROVIDER_FAILURE';

export type SupportedCurrency =
	| 'TWD'
	| 'USD'
	| 'JPY'
	| 'EUR'
	| 'GBP'
	| 'KRW'
	| 'CNY'
	| 'HKD'
	| 'SGD'
	| 'THB';

export interface FieldMetadata {
	recognition_status: RecognitionStatus;
	confidence: number | null;
	warnings: ReceiptWarningCode[];
}

export interface NormalizedField<T> {
	value: T | null;
	metadata: FieldMetadata;
}

export interface NormalizedLineItem {
	metadata: FieldMetadata;
	description: NormalizedField<string>;
	quantity: NormalizedField<string>;
	unit_price: NormalizedField<string>;
	line_total: NormalizedField<string>;
}

export interface NormalizedReceipt {
	merchant: NormalizedField<string>;
	purchase_date: NormalizedField<string>;
	grand_total: NormalizedField<string>;
	currency: NormalizedField<SupportedCurrency>;
	line_items: NormalizedField<NormalizedLineItem[]>;
}

export interface RecognizedValue<T> {
	state: 'recognized';
	value: T;
	confidence?: number | null;
}

export interface UnrecognizedValue {
	state: 'unrecognized';
}

export type RawField<T> = RecognizedValue<T> | UnrecognizedValue | null;

export interface RawLineItem {
	description?: RawField<string>;
	quantity?: RawField<number>;
	unit_price?: RawField<number>;
	line_total?: RawField<number>;
}

export interface RawReceipt {
	merchant?: RawField<{ name: string }>;
	purchase_date?: RawField<string>;
	totals?: RawField<{ grand_total: number }>;
	currency?: RawField<SupportedCurrency>;
	line_items?: RawField<RawLineItem[]>;
}

export interface RawReceiptDocument {
	document_type: 'receipt';
	receipt: RawReceipt;
}

export interface RawNotReceiptDocument {
	document_type: 'not_a_receipt';
}

export interface ValidationWarning {
	code: ReceiptWarningCode;
	field: string | null;
	message: string;
}

export interface ReceiptVersionIdentifiers {
	contract: string;
	prompt: string;
	model: string;
	schema_version: string;
}

interface ReceiptEnvelopeBase<S extends ReceiptAnalysisStatus> {
	contract_version: 'receipt-result.v1';
	status: S;
	validation: {
		outcome: S;
		warnings: ValidationWarning[];
	};
	versions: ReceiptVersionIdentifiers;
}

interface ReceiptDocumentResponse<
	S extends 'auto_acceptable' | 'needs_review'
> extends ReceiptEnvelopeBase<S> {
	raw_extraction: RawReceiptDocument;
	normalized_receipt: NormalizedReceipt;
}

export type AutoAcceptableReceiptResponse = ReceiptDocumentResponse<'auto_acceptable'>;
export type NeedsReviewReceiptResponse = ReceiptDocumentResponse<'needs_review'>;
export type SuccessfulReceiptResponse = AutoAcceptableReceiptResponse | NeedsReviewReceiptResponse;

export interface InvalidReceiptResponse extends ReceiptEnvelopeBase<'invalid'> {
	raw_extraction: RawNotReceiptDocument;
	normalized_receipt: null;
}

export interface RetryableReceiptResponse extends ReceiptEnvelopeBase<'retryable_failure'> {
	raw_extraction: null;
	normalized_receipt: null;
}

export type ReceiptAnalysisResponse =
	| SuccessfulReceiptResponse
	| InvalidReceiptResponse
	| RetryableReceiptResponse;

/** @deprecated Use ReceiptAnalysisResponse. */
export type AnalyzeReceiptResponse = ReceiptAnalysisResponse;

export type AIReceiptErrorCode =
	| 'INVALID_REQUEST'
	| 'INVALID_FILE_PATH'
	| 'TOO_MANY_IMAGES'
	| 'INVALID_TOKEN'
	| 'FILE_ACCESS_DENIED'
	| 'BLOB_NOT_FOUND'
	| 'IMAGE_TOO_LARGE'
	| 'REQUEST_TOO_LARGE'
	| 'UNSUPPORTED_IMAGE_MIME_TYPE'
	| 'INVALID_IMAGE_METADATA'
	| 'STORAGE_PROVIDER_FAILURE'
	| 'INVALID_MODEL_OUTPUT'
	| 'PROVIDER_FAILURE'
	| 'UPLOAD_FAILED';

export type AIReceiptRecovery =
	| 'modify_selection'
	| 'reupload'
	| 'retry'
	| 'reauthenticate'
	| 'unknown';

export interface AIReceiptErrorInfo {
	code?: string;
	message: string;
	recovery: AIReceiptRecovery;
}

export class AIReceiptAPIError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly code?: AIReceiptErrorCode | string
	) {
		super(message);
		this.name = 'AIReceiptAPIError';
	}
}

const errorMessages: Partial<Record<AIReceiptErrorCode, string>> = {
	INVALID_REQUEST: '圖片請求格式不正確，請重新選取圖片。',
	INVALID_FILE_PATH: '已上傳圖片的路徑無效，請重新上傳。',
	TOO_MANY_IMAGES: '一次最多只能分析 4 張圖片。',
	INVALID_TOKEN: '登入狀態已失效，請重新登入。',
	FILE_ACCESS_DENIED: '無法存取已上傳的圖片，請重新上傳。',
	BLOB_NOT_FOUND: '找不到已上傳的圖片，請重新上傳。',
	IMAGE_TOO_LARGE: '單張圖片不可超過 10 MiB。',
	REQUEST_TOO_LARGE: '圖片總大小不可超過 20 MiB。',
	UNSUPPORTED_IMAGE_MIME_TYPE: '僅支援 JPEG、PNG、WebP，以及可轉換的 HEIC/HEIF 圖片。',
	INVALID_IMAGE_METADATA: '圖片內容或格式驗證失敗，請重新選取圖片。',
	STORAGE_PROVIDER_FAILURE: '圖片儲存服務暫時無法使用，請稍後重試。',
	INVALID_MODEL_OUTPUT: 'AI 回傳的收據資料格式無效，請重新分析。',
	PROVIDER_FAILURE: 'AI 分析服務暫時無法使用，請稍後重試。',
	UPLOAD_FAILED: '圖片上傳失敗，請重新上傳。'
};

function getRecovery(code?: string): AIReceiptRecovery {
	switch (code) {
		case 'INVALID_REQUEST':
		case 'TOO_MANY_IMAGES':
		case 'IMAGE_TOO_LARGE':
		case 'REQUEST_TOO_LARGE':
		case 'UNSUPPORTED_IMAGE_MIME_TYPE':
			return 'modify_selection';
		case 'INVALID_FILE_PATH':
		case 'FILE_ACCESS_DENIED':
		case 'BLOB_NOT_FOUND':
		case 'INVALID_IMAGE_METADATA':
		case 'UPLOAD_FAILED':
			return 'reupload';
		case 'STORAGE_PROVIDER_FAILURE':
		case 'INVALID_MODEL_OUTPUT':
		case 'PROVIDER_FAILURE':
			return 'retry';
		case 'INVALID_TOKEN':
			return 'reauthenticate';
		default:
			return 'unknown';
	}
}

export function getAIReceiptErrorInfo(error: unknown): AIReceiptErrorInfo {
	if (error instanceof AIReceiptAPIError) {
		const code = error.code;
		return {
			code,
			message:
				(code ? errorMessages[code as AIReceiptErrorCode] : undefined) ??
				error.message ??
				'處理收據時發生錯誤。',
			recovery: getRecovery(code)
		};
	}
	return {
		message: '處理收據時發生錯誤，請稍後再試。',
		recovery: 'unknown'
	};
}

function toExtractionValue<T>(field: NormalizedField<T>): ExtractionValue<T> | undefined {
	switch (field.metadata.recognition_status) {
		case 'recognized':
			return field.value === null ? undefined : { state: 'recognized', value: field.value };
		case 'explicit_null':
			return null;
		case 'unrecognized':
			return { state: 'unrecognized' };
		case 'missing':
			return undefined;
	}
}

/** Converts the normalized v1 contract into the extraction shape used by the current review UI. */
export function toReceiptAnalysisResult(response: ReceiptAnalysisResponse): ReceiptAnalysisResult {
	if (response.status === 'invalid') {
		return response.raw_extraction;
	}

	if (response.status === 'retryable_failure') {
		const warning = response.validation.warnings[0];
		throw new AIReceiptAPIError(
			warning?.message ?? 'AI receipt analysis failed',
			502,
			warning?.code
		);
	}

	const receipt = response.normalized_receipt;
	const normalizedItems = toExtractionValue(receipt.line_items);
	let lineItems: ExtractionValue<ReceiptLineItem[]> | undefined;
	if (normalizedItems?.state === 'recognized') {
		lineItems = {
			state: 'recognized',
			value: normalizedItems.value.map((item) => ({
				description: toExtractionValue(item.description),
				quantity: toExtractionValue(item.quantity),
				unit_price: toExtractionValue(item.unit_price),
				line_total: toExtractionValue(item.line_total)
			}))
		};
	} else {
		lineItems = normalizedItems;
	}

	const merchant = toExtractionValue(receipt.merchant);
	const grandTotal = toExtractionValue(receipt.grand_total);

	return {
		document_type: 'receipt',
		receipt: {
			merchant:
				merchant?.state === 'recognized'
					? { state: 'recognized', value: { name: merchant.value } }
					: merchant,
			purchase_date: toExtractionValue(receipt.purchase_date),
			totals:
				grandTotal?.state === 'recognized'
					? { state: 'recognized', value: { grand_total: grandTotal.value } }
					: grandTotal,
			currency: toExtractionValue(receipt.currency),
			line_items: lineItems
		}
	};
}

async function throwResponseError(response: Response, fallbackMessage: string): Promise<never> {
	let errorCode: string | undefined;
	let errorMessage = response.statusText;
	try {
		const body = (await response.json()) as {
			code?: string;
			message?: string;
			error?: { code?: string; message?: string };
			validation?: { warnings?: ValidationWarning[] };
		};
		const warning = body.validation?.warnings?.[0];
		errorCode = body.error?.code ?? body.code ?? warning?.code;
		errorMessage = body.error?.message ?? body.message ?? warning?.message ?? errorMessage;
	} catch {
		// Use the response status when an upstream error is not JSON.
	}
	throw new AIReceiptAPIError(
		errorMessage || `${fallbackMessage} (${response.status})`,
		response.status,
		errorCode
	);
}

async function getAccessToken() {
	const {
		data: { session }
	} = await supabase.auth.getSession();
	const accessToken = session?.access_token;
	if (!accessToken) {
		throw new AIReceiptAPIError('No access token found', 401, 'INVALID_TOKEN');
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
		return throwResponseError(response, 'Failed to get upload URL');
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
		return throwResponseError(response, 'Failed to analyze receipt');
	}

	return (await response.json()) as ReceiptAnalysisResponse;
}
