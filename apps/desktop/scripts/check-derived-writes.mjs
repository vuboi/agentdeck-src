#!/usr/bin/env node
// Warns when messagesOf( (a function that WRITES chat state) is called where Svelte
// forbids state writes: inside a $derived expression, or in a .svelte template.
// Use messagesView( (read-only) there instead. Warn-only: always exits 0.
// Usage: node scripts/check-derived-writes.mjs [dir]   (default: src)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.argv[2] ?? 'src';
const NAME = 'messagesOf(';
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

// Return [start, end) of the parenthesised group that starts at text[open] === '('.
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

function check(file) {
    const text = readFileSync(file, 'utf8');
    const rel = relative('.', file);

    // 1) messagesOf( inside a $derived / $derived.by expression.
    const derivedRe = /\$derived(\.by)?\s*\(/g;
    let m;
    while ((m = derivedRe.exec(text))) {
        const open = text.indexOf('(', m.index);
        const end = groupEnd(text, open);
        const body = text.slice(open, end);
        let at = body.indexOf(NAME);
        while (at !== -1) {
            warnings.push(
                `${rel}:${lineOf(text, open + at)}: messagesOf( inside $derived (use messagesView)`,
            );
            at = body.indexOf(NAME, at + NAME.length);
        }
    }

    // 2) messagesOf( in a .svelte template (anything after the last </script>).
    if (file.endsWith('.svelte')) {
        const scriptEnd = text.lastIndexOf('</script>');
        const templateStart =
            scriptEnd === -1 ? 0 : scriptEnd + '</script>'.length;
        let at = text.indexOf(NAME, templateStart);
        while (at !== -1) {
            warnings.push(
                `${rel}:${lineOf(text, at)}: messagesOf( in template (use messagesView)`,
            );
            at = text.indexOf(NAME, at + NAME.length);
        }
    }
}

for (const file of walk(root)) check(file);

for (const w of warnings) console.warn(`warn: ${w}`);
console.log(`check-derived-writes: ${warnings.length} warning(s) in ${root}`);
process.exit(0);
