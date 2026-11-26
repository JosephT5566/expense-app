import { addCollection } from '@iconify/svelte/dist/OfflineIcon.svelte';
import collections from './iconify-subset.json';

for (const collection of Object.values(collections)) {
	addCollection(collection);
}
