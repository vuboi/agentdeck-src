// Run with: node --test tests/svelte-modules-compile.test.mjs
// svelte-check does not run the rune placement rules of the compiler on .svelte.ts modules, so a misplaced `$state`
// (state_invalid_placement) passed it and only failed when Vite loaded the file. Every module is compiled here the way
// vite-plugin-svelte does it: types stripped first, then svelte's compileModule.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { compileModule } from 'svelte/compiler';

const ts = createRequire(import.meta.url)('typescript');
const src = new URL('../src', import.meta.url).pathname.replace(
    /^\/(\w:)/,
    '$1',
);

function modules(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) modules(path, out);
        else if (entry.endsWith('.svelte.ts') || entry.endsWith('.svelte.js'))
            out.push(path);
    }
    return out;
}

test('every .svelte.ts module compiles with the svelte compiler', () => {
    const failures = [];
    for (const file of modules(src)) {
        const code = ts.transpileModule(readFileSync(file, 'utf8'), {
            compilerOptions: {
                target: ts.ScriptTarget.ESNext,
                module: ts.ModuleKind.ESNext,
                verbatimModuleSyntax: true,
            },
        }).outputText;
        try {
            compileModule(code, { filename: file, generate: 'client' });
        } catch (error) {
            failures.push(
                `${relative(src, file)}: ${String(error.message ?? error).split('\n')[0]}`,
            );
        }
    }
    assert.deepEqual(failures, []);
});
