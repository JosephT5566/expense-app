import { supabase } from '$lib/supabase/supabaseClient';
import type { CategoryRow, CategoryKind } from '$lib/types/category';

const TABLE = 'categories';

export interface ListCategoriesParams {
	kind?: CategoryKind; // optional filter
}

export async function listCategories(params: ListCategoriesParams = {}): Promise<CategoryRow[]> {
	let query = supabase.from(TABLE).select('*').order('sort_order', { ascending: true });

	if (params.kind) {
		query = query.eq('kind', params.kind);
	}

	const { data, error } = await query;
    console.log('list categories', data, error);

	if (error) {
		throw error;
	}

	return data ?? [];
}
