import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
const url = process.env.TEST_SUPABASE_URL ?? process.env.API_URL ?? '';
// Fail closed before constructing any privileged client, including when configuration is missing.
if (!url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) {
	throw new Error('Integration tests require an explicit localhost Supabase URL');
}
const syntheticJwt = (role: string, email?: string, sub?: string) => {
	const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
	const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, email, sub, exp: 4102444800 })}`;
	return `${body}.${createHmac('sha256', 'synthetic-local-test-secret-at-least-32-characters').update(body).digest('base64url')}`;
};
const standalone = process.env.TEST_STANDALONE_POSTGREST === '1';
const key = standalone
	? syntheticJwt('anon')
	: (process.env.TEST_SUPABASE_ANON_KEY ?? process.env.ANON_KEY ?? '');
const options = {
	auth: { persistSession: false, autoRefreshToken: false },
	global: {
		fetch: (input: RequestInfo | URL, init?: RequestInit) =>
			fetch(standalone ? String(input).replace('/rest/v1', '') : input, init)
	}
};
const admin = createClient(
	url,
	standalone
		? syntheticJwt('service_role')
		: (process.env.TEST_SUPABASE_SERVICE_KEY ?? process.env.SERVICE_ROLE_KEY ?? ''),
	options
);
const anon = createClient(url, key, options);
let a: SupabaseClient;
let b: SupabaseClient;
const payload = (email = 'a@example.test') => ({
	note: 'synthetic integration',
	amount: 851,
	currency: 'TWD',
	ts: '2026-03-01T16:00:00.000Z',
	payer_email: email,
	scope: 'personal',
	shares_json: { [email]: 851 },
	category_id: '11111111-1111-4111-8111-111111111111',
	is_settled: true
});
const hash = 'a'.repeat(64);
async function caller(email: string) {
	if (standalone) {
		return createClient(url, key, {
			...options,
			global: {
				...options.global,
				headers: {
					Authorization: `Bearer ${syntheticJwt('authenticated', email, email.startsWith('a') ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')}`
				}
			}
		});
	}
	const client = createClient(url, key, options);
	const password = 'Synthetic-only-test-password-573!';
	const signed = await client.auth.signInWithPassword({ email, password });
	if (signed.error) {
		const signup = await client.auth.signUp({ email, password });
		if (signup.error) {
			throw signup.error;
		}
	}
	return client;
}
beforeAll(async () => {
	a = await caller('a@example.test');
	b = await caller('b@example.test');
	// The local-only guard above protects these synthetic reset operations.
	for (const table of ['semantic_entry_requests', 'semantic_entry_quota', 'expenses']) {
		await admin
			.from(table)
			.delete()
			.not(table === 'expenses' ? 'id' : 'user_id', 'is', null);
	}
}, 30000);
const create = (client: SupabaseClient, id: string, expense = payload(), inputHash = hash) =>
	client.rpc('create_semantic_expense', {
		p_request_id: id,
		p_input_hash: inputHash,
		p_expense: expense
	});
describe('disposable RPC transactions and authorization', () => {
	it('creates one expense for twenty concurrent matching requests', async () => {
		const id = randomUUID();
		const results = await Promise.all(Array.from({ length: 20 }, () => create(a, id)));
		for (const r of results) {
			expect(r.error).toBeNull();
		}
		expect(new Set(results.map((r) => r.data.expense.id)).size).toBe(1);
		expect(results.filter((r) => !r.data.replayed)).toHaveLength(1);
		const rows = await admin.from('expenses').select('id').eq('id', results[0].data.expense.id);
		expect(rows.data).toHaveLength(1);
	});
	it('rejects a changed hash with the domain conflict', async () => {
		const id = randomUUID();
		expect((await create(a, id)).error).toBeNull();
		expect((await create(a, id, payload(), 'b'.repeat(64))).error?.code).toBe('PT409');
	});
	it('isolates identical request UUIDs across users', async () => {
		const id = randomUUID();
		const first = await create(a, id);
		const second = await create(b, id, payload('b@example.test'));
		expect(first.error).toBeNull();
		expect(second.error).toBeNull();
		expect(first.data.expense.id).not.toBe(second.data.expense.id);
		const privateRows = await b
			.from('semantic_entry_requests')
			.select('*')
			.eq('expense_id', first.data.expense.id);
		expect(privateRows.error).toBeNull();
		expect(privateRows.data).toEqual([]);
	});
	it('rolls back the request row on validation failure', async () => {
		const id = randomUUID();
		const failed = await create(a, id, { ...payload(), amount: -1 });
		expect(failed.error).not.toBeNull();
		expect(
			(await admin.from('semantic_entry_requests').select('*').eq('request_id', id)).data
		).toEqual([]);
	});
	it('replays a discarded response and never overwrites edits or resurrects deletion', async () => {
		const id = randomUUID();
		await create(a, id);
		const replay = await create(a, id);
		expect(replay.error).toBeNull();
		expect(replay.data.replayed).toBe(true);
		const expenseId = replay.data.expense.id;
		expect(
			(await a.from('expenses').update({ note: 'edited' }).eq('id', expenseId)).error
		).toBeNull();
		expect((await create(a, id)).data.expense.note).toBe('synthetic integration');
		expect(
			(await a.from('expenses').select('note').eq('id', expenseId).single()).data?.note
		).toBe('edited');
		expect((await a.from('expenses').delete().eq('id', expenseId)).error).toBeNull();
		expect((await create(a, id)).data.expense.id).toBe(expenseId);
		expect((await a.from('expenses').select('*').eq('id', expenseId)).data).toEqual([]);
	});
	it('denies direct ledger and quota mutations and anonymous RPCs', async () => {
		for (const table of ['semantic_entry_requests', 'semantic_entry_quota']) {
			expect((await a.from(table).insert({ user_id: randomUUID() })).error).not.toBeNull();
			expect(
				(await a.from(table).update({ user_id: randomUUID() }).not('user_id', 'is', null))
					.error
			).not.toBeNull();
			expect((await a.from(table).delete().not('user_id', 'is', null)).error).not.toBeNull();
		}
		expect((await create(anon, randomUUID())).error).not.toBeNull();
		expect((await anon.rpc('consume_semantic_entry_quota')).error).not.toBeNull();
	});
	it('allows exactly one hundred out of 101 concurrent quota attempts', async () => {
		const results = await Promise.all(
			Array.from({ length: 101 }, () => a.rpc('consume_semantic_entry_quota'))
		);
		for (const r of results) {
			expect(r.error).toBeNull();
		}
		expect(results.filter((r) => r.data === true)).toHaveLength(100);
		expect(results.filter((r) => r.data === false)).toHaveLength(1);
	});
});
it('rolls back both rows when the expense insert itself fails after validation', async () => {
	const before = await admin.from('expenses').select('id', { count: 'exact', head: true });
	const id = randomUUID();
	const failed = await create(a, id, { ...payload(), note: 'fixture_insert_failure' });
	expect(failed.error).not.toBeNull();
	expect(
		(await admin.from('semantic_entry_requests').select('*').eq('request_id', id)).data
	).toEqual([]);
	expect((await admin.from('expenses').select('id', { count: 'exact', head: true })).count).toBe(
		before.count
	);
});
it.each([
	{ ...payload(), currency: 'USD' },
	{ ...payload(), amount: 1.5 },
	{ ...payload(), payer_email: 'b@example.test' },
	{ ...payload(), is_settled: false },
	{ ...payload(), shares_json: { 'unknown@example.test': 851 } },
	{
		...payload(),
		scope: 'household',
		is_settled: false,
		shares_json: { 'a@example.test': 850, 'b@example.test': 1 }
	},
	{ ...payload(), ts: '2026-03-01T17:00:00Z' }
])('rejects forged or unsupported RPC payloads', async (expense) => {
	const id = randomUUID();
	expect((await create(a, id, expense)).error).not.toBeNull();
	expect(
		(await admin.from('semantic_entry_requests').select('*').eq('request_id', id)).data
	).toEqual([]);
});
