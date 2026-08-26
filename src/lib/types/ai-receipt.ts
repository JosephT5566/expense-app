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
