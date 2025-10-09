import { writable } from 'svelte/store';
import { listAppSetting } from '$lib/data/appSetting.fetcher';

function createAppSettingStore() {
    const allowedUsers = writable<string[]>([]);
    const loading = writable(false);
    const error = writable<unknown>(null);

    async function load() {
        loading.set(true);
        error.set(null);
        try {
            const res = await listAppSetting();
            allowedUsers.set(res[0]?.allowed_emails ?? []);
        } catch (e) {
            error.set(e);
        } finally {
            loading.set(false);
        }
    }

    return { loading, error, load, users: allowedUsers };
}

export const appSettingStore = createAppSettingStore();
