export default {
    '*.{js,cjs,mjs,ts,tsx,svelte}': ['eslint --fix', 'prettier --write'],
    '*.{json,jsonc,css,scss,html,md,yml,yaml}': 'prettier --write',
    '*.rs': 'rustfmt --edition 2021',
};
