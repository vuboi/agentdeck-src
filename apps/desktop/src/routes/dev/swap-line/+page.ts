import { error } from '@sveltejs/kit';

// Dev only: a comparison page for the running-line swap (see +page.svelte). Not prerendered, so the static build has no
// /dev/swap-line file, and it answers 404 outside `pnpm dev`.
export const prerender = false;

export const load = () => {
    if (!import.meta.env.DEV) error(404, 'Not found');
};
