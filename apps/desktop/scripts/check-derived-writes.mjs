#!/usr/bin/env node
// Warns when a function that WRITES reactive state is called where Svelte forbids state
// writes: inside a $derived expression, or in a .svelte template. Such a write throws
// `state_unsafe_mutation` and the chat row shows "This message could not be drawn".
// Each writer has a read-only twin to use there instead (see WRITERS).
// Usage: node scripts/check-derived-writes.mjs [dir] [--strict]   (default dir: src)
// Warn-only by default (exit 0); --strict exits 1 when anything is found (used by the test).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const root = args.find((arg) => !arg.startsWith('--')) ?? 'src';

/** Functions that write state, and the read-only function to call while rendering. */
const WRITERS = [
    { name: 'messagesOf(', use: 'messagesView' },
    { name: 'editGroup(', use: 'groupView' },
    { name: 'groupState(', use: 'groupView' },
];
const warnings = [];

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (/\.svelte(\.ts)?$/.test(entry)) out.push(path);
    }
    return out;
}

// Line number (1-based) of an index in text.
function lineOf(text, index) {
    return text.slice(0, index).split('\n').length;
}

// Index of the ')' that closes the parenthesised group starting at text[open] === '('.
function groupEnd(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return text.length;
}

// Every index of `name` in text[from, to), skipping longer identifiers that end with it (e.g. `xmessagesOf(`).
function* occurrences(text, name, from, to) {
    let at = text.indexOf(name, from);
    while (at !== -1 && at < to) {
        if (!/[\w$]/.test(text[at - 1] ?? '')) yield at;
        at = text.indexOf(name, at + name.length);
    }
}

function check(file) {
    const text = readFileSync(file, 'utf8');
    const rel = relative('.', file);

    // 1) A writer inside a $derived / $derived.by expression.
    const derivedRe = /\$derived(\.by)?\s*\(/g;
    let m;
    while ((m = derivedRe.exec(text))) {
        const open = text.indexOf('(', m.index);
        const end = groupEnd(text, open);
        for (const { name, use } of WRITERS)
            for (const at of occurrences(text, name, open, end))
                warnings.push(
                    `${rel}:${lineOf(text, at)}: ${name} inside $derived (use ${use})`,
                );
    }

    // 2) A writer in a .svelte template (anything after the last </script>). Event handlers there are flagged
    //    too: move the write into a function in the script, which keeps the template read-only.
    if (file.endsWith('.svelte')) {
        const scriptEnd = text.lastIndexOf('</script>');
        const templateStart =
            scriptEnd === -1 ? 0 : scriptEnd + '</script>'.length;
        for (const { name, use } of WRITERS)
            for (const at of occurrences(
                text,
                name,
                templateStart,
                text.length,
            ))
                warnings.push(
                    `${rel}:${lineOf(text, at)}: ${name} in template (use ${use})`,
                );
    }
}

for (const file of walk(root)) check(file);

for (const w of warnings) console.warn(`warn: ${w}`);
console.log(`check-derived-writes: ${warnings.length} warning(s) in ${root}`);
process.exit(strict && warnings.length ? 1 : 0);
