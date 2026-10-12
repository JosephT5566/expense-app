import { createClient } from '@supabase/supabase-js';
import {
	parseCompletedResult,
	parseExpenseRow,
	type SemanticContext
} from '@jopie/semantic-entry-contract';
import type { Adapter, VerifiedUser } from './graph';
import { SemanticError } from './errors';
export interface SupabaseConfig {
	url: string;
	publishableKey: string;
	memberNames: Record<string, string>;
	otherCategoryId: string;
	fetch?: typeof fetch;
}
export function createSupabaseAdapter(
	config: SupabaseConfig,
	token: string,
	signal: AbortSignal
): Adapter {
	const client = createClient(config.url, config.publishableKey, {
		auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
		global: {
			headers: { Authorization: `Bearer ${token}` },
			fetch: (input, init) => {
				signal.throwIfAborted();
				return (config.fetch ?? fetch)(input, { ...init, signal });
			}
		}
	});
	let verified: VerifiedUser | undefined;
	const error = (e: { code?: string } | null, uncertain = false) => {
		if (!e) {
			return;
		}
		const status = Number(e.code?.replace('PT', ''));
		if ([400, 401, 403, 409, 422, 429].includes(status)) {
			throw new SemanticError(status, status === 409 ? 'conflict' : 'rpc_rejected');
		}
		throw new SemanticError(
			uncertain ? 504 : 502,
			uncertain ? 'persist_uncertain' : 'database_error',
			uncertain
		);
	};
	return {
		async authenticate() {
			const { data, error: e } = await client.auth.getUser(token);
			if (e || !data.user?.id || !data.user.email) {
				throw new SemanticError(401, 'unauthorized');
			}
			verified = { id: data.user.id, email: data.user.email };
			return verified;
		},
		async loadContext(user) {
			if (!verified || verified.id !== user.id) {
				throw new SemanticError(401, 'unauthorized');
			}
			const [settings, categories] = await Promise.all([
				client.from('app_settings').select('allowed_emails').eq('id', true).single(),
				client.from('categories').select('id,name').eq('kind', 'expense')
			]);
			error(settings.error);
			error(categories.error);
			const emails: unknown = settings.data?.allowed_emails;
			if (
				!Array.isArray(emails) ||
				!emails.every((email) => typeof email === 'string') ||
				!emails.includes(user.email)
			) {
				throw new SemanticError(403, 'forbidden');
			}
			const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
			return {
				today,
				currentUserEmail: user.email,
				members: emails.map((email, index) => ({
					id: `member-${index}`,
					email,
					name: config.memberNames[email] ?? email
				})),
				categories: categories.data ?? [],
				otherCategoryId: config.otherCategoryId
			} satisfies SemanticContext;
		},
		async lookupCompleted(requestId, inputHash) {
			if (!verified) {
				throw new SemanticError(401, 'unauthorized');
			}
			const found = await client
				.from('semantic_entry_requests')
				.select('input_hash,result')
				.eq('user_id', verified.id)
				.eq('request_id', requestId)
				.maybeSingle();
			error(found.error);
			if (!found.data) {
				return null;
			}
			if (inputHash && found.data.input_hash !== inputHash) {
				throw new SemanticError(409, 'conflict');
			}
			return { expense: parseExpenseRow(found.data.result), replayed: true };
		},
		async consumeQuota() {
			const result = await client.rpc('consume_semantic_entry_quota');
			error(result.error);
			if (typeof result.data !== 'boolean') {
				throw new SemanticError(502, 'database_invalid');
			}
			return result.data;
		},
		async persistExpense(requestId, inputHash, expense) {
			let result;
			try {
				result = await client.rpc('create_semantic_expense', {
					p_request_id: requestId,
					p_input_hash: inputHash,
					p_expense: expense
				});
			} catch {
				throw new SemanticError(504, 'persist_uncertain', true);
			}
			error(result.error, true);
			try {
				return parseCompletedResult(result.data);
			} catch {
				throw new SemanticError(504, 'persist_uncertain', true);
			}
		}
	};
}
