import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const outDir = process.env.AGENTDECK_SVELTEKIT_OUT_DIR ?? '.svelte-kit';

export default {
    preprocess: vitePreprocess(),
    kit: {
        outDir,
        adapter: adapter({
            pages: 'build/web',
            assets: 'build/web',
            fallback: 'index.html',
        }),
        alias: { $components: './src/lib/components' },
    },
};
