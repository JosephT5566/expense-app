import { onMount } from 'svelte';
import { writable } from 'svelte/store';
import mobile from 'is-mobile';

export function getIsMobile() {
	const isMobile = writable(false);

	onMount(() => {
		isMobile.set(mobile());
	});

	return isMobile;
}
