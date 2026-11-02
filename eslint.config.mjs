import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';
import svelteConfig from './apps/desktop/svelte.config.js';

export default tseslint.config(
    {
        ignores: [
            '**/node_modules/**',
            '**/target/**',
            '**/build/**',
            '**/.svelte-kit*/**',
            '.codex/**',
            '.claude/**',
            '.agentdeck/**',
            '.agentdeck-dev/**',
            '.tmp/**',
            'apps/desktop/src-tauri/gen/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    ...svelte.configs.recommended,
    {
        languageOptions: {
            globals: { ...globals.browser, ...globals.node },
        },
    },
    {
        files: ['**/*.svelte'],
        languageOptions: {
            parserOptions: {
                parser: tseslint.parser,
                svelteConfig,
            },
        },
    },
    ...svelte.configs.prettier,
    {
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: {
            parser: tseslint.parser,
        },
    },
    eslintConfigPrettier,
);
