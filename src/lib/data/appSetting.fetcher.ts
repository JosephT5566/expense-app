import { supabase } from '$lib/supabase/supabaseClient';
import type { AppSettingRow } from '$lib/types/appSetting';

const TABLE = 'categories';

export async function listAppSetting(): Promise<AppSettingRow[]> {
    const query = supabase.from(TABLE).select('*').eq('id', true ).limit(1);

    const { data, error } = await query;

    if (error) {
        throw error;
    }

    return data ?? [];
}
