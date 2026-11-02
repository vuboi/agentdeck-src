import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
    DELEGATE_HINT,
    SAVE_TOKENS_RULE,
    formatAgents,
    looksNontrivial,
    parseDelegateArgs,
    replacementTask,
    privateContentIn,
    demandsLanguage,
    DEMANDED_LANGUAGE_RULE,
    workerLanguageRule,
    DEFAULT_TIMEOUT_S,
    MIN_TIMEOUT_S,
    MAX_TIMEOUT_S,
    TASK_MAX_CHARS,
    QUESTION_WAIT_MS,
    MAX_WORKERS,
    routesForChat,
} from './delegate-task.ts';

test('light public work may go to a free tier', () => {
    assert.equal(
        privateContentIn(
            'Write a polite email asking the landlord to fix the heater by Friday.',
        ),
        null,
    );
    assert.equal(
        privateContentIn(
            'Search the web for the latest Svelte 5 release notes and summarise them.',
        ),
        null,
    );
    assert.equal(
        privateContentIn(
            'Shorten this line:\n```ts\nconst total = items.reduce((sum, item) => sum + item.price, 0);\n```',
        ),
        null,
    );
});

test('secrets never reach a free tier', () => {
    assert.match(
        privateContentIn(
            'Use key sk-proj-abcdefghijklmnopqrstuvwx to call the API',
        ) ?? '',
        /API key/,
    );
    assert.match(
        privateContentIn('token ghp_abcdefghijklmnopqrstuvwxyz0123456789') ??
            '',
        /API key/,
    );
    assert.match(
        privateContentIn('-----BEGIN OPENSSH PRIVATE KEY-----\nabc') ?? '',
        /private key/,
    );
    assert.match(
        privateContentIn(
            'connect to postgres://admin:hunter22@db.internal/app',
        ) ?? '',
        /password/,
    );
    assert.match(privateContentIn('DB_PASSWORD="hunter2222"') ?? '', /secret/);
    assert.match(
        privateContentIn('export OPENAI_API_KEY=abc') ?? '',
        /environment/,
    );
    assert.match(
        privateContentIn('the API is at http://10.0.0.5:8080') ?? '',
        /IP/,
    );
    assert.match(
        privateContentIn('see https://billing.internal/docs') ?? '',
        /host/,
    );
});

test('a file of source code never reaches a free tier', () => {
    const file = Array.from({ length: 40 }, (_, i) => `let v${i} = ${i};`).join(
        '\n',
    );
    assert.match(
        privateContentIn(`Refactor this:\n\`\`\`ts\n${file}\n\`\`\``) ?? '',
        /lines of code/,
    );
});

test('list_agents marks a free tier', () => {
    const text = formatAgents([
        {
            id: 'custom-1',
            label: 'Groq',
            models: [{ value: 'llama', label: 'llama' }],
            restricted: true,
        },
    ]);
    assert.match(text, /FREE TIER/);
});

test('looksNontrivial: short Q&A and acknowledgements are not', () => {
    for (const text of [
        'thanks',
        'ok',
        'what does this flag do?',
        'cảm ơn nhé',
        'Why is the sky blue?',
    ])
        assert.equal(looksNontrivial(text), false, text);
});

test('looksNontrivial: work keywords, English and Vietnamese with or without diacritics', () => {
    for (const text of [
        'Please refactor the sidebar',
        'investigate the crash',
        'triển khai tính năng này',
        'trien khai tinh nang nay',
        'nghiên cứu cách làm',
        'sửa lỗi đăng nhập',
        'thêm tính năng export',
    ])
        assert.equal(looksNontrivial(text), true, text);
});

test('looksNontrivial: long prompts, many lines, project mentions, stripped lead', () => {
    assert.equal(looksNontrivial('x '.repeat(150)), true);
    assert.equal(looksNontrivial('a\nb\nc\nd\ne'), true);
    assert.equal(looksNontrivial('hi', [{ kind: 'project' }]), true);
    assert.equal(looksNontrivial('hi', [{ kind: 'session' }]), false);
    assert.equal(
        looksNontrivial('[AgentDeck] build review plan.\n\nthanks'),
        false,
    );
});

test('a bare "làm"/"sửa" still counts as work', () => {
    for (const text of [
        'ok làm đi',
        'sửa đi',
        'làm tiếp',
        'ok lam di',
        'sua di',
        'sửa lỗi đăng nhập',
        'làm tính năng export',
    ])
        assert.equal(looksNontrivial(text), true, text);
});

test('continue replaces agent; empty agent without continue is refused', () => {
    const ok = parseDelegateArgs({ continue: ' t-ab12cd ', task: 'fix it' });
    assert.ok(
        ok.ok && ok.args.continueId === 't-ab12cd' && ok.args.agent === '',
    );
    assert.equal(parseDelegateArgs({ task: 'x' }).ok, false);
    assert.equal(parseDelegateArgs({ continue: 't-ab12cd' }).ok, false);
});

test('demandsLanguage spots explicit all-output language demands in any language', () => {
    for (const yes of [
        'trả lời tất cả bằng tiếng Việt',
        'tra loi tat ca bang tieng viet',
        'toàn bộ tiếng Việt nhé',
        'viết bằng tiếng Anh toàn bộ',
        'Answer everything in Japanese',
        'all output in German please',
        'reply only in French',
        'write all replies in my language',
    ])
        assert.equal(demandsLanguage(yes), true, yes);
    for (const no of [
        'sửa lỗi này giúp tôi',
        'fix all bugs in the plan',
        'làm tất cả trong 2 tiếng nữa',
        'translate this file to Spanish',
        'update every test in src',
    ])
        assert.equal(demandsLanguage(no), false, no);
});

test('worker language rule follows the request and the quota', () => {
    const ja = workerLanguageRule('このバグを直してください', 10);
    assert.match(ja, /このバグを直してください/);
    assert.match(ja, /language of the user's original request/);
    assert.equal(
        workerLanguageRule('arregla este error', 49).includes(
            'arregla este error',
        ),
        true,
    );
    assert.equal(workerLanguageRule('sửa', 50), SAVE_TOKENS_RULE);
    assert.equal(workerLanguageRule('fix', 80), SAVE_TOKENS_RULE);
    assert.notEqual(workerLanguageRule('fix', null), SAVE_TOKENS_RULE);
    const demanded = workerLanguageRule(
        'trả lời tất cả bằng tiếng Việt: sửa lỗi',
        90,
    );
    assert.notEqual(demanded, SAVE_TOKENS_RULE);
    assert.match(
        demanded,
        new RegExp(
            DEMANDED_LANGUAGE_RULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        ),
    );
    assert.match(
        workerLanguageRule('Answer everything in Japanese', 75),
        /every reply in their language/,
    );
    assert.match(DELEGATE_HINT, /continue=<task_id>/);
});

test('replacement workers receive transcript or fallback report and failure reason', () => {
    const seed = replacementTask(
        'finish',
        'Antigravity · Opus',
        'Assistant: partial',
        'old report',
        'quota exhausted',
    );
    assert.match(seed, /Antigravity · Opus \(previous worker\)/);
    assert.match(seed, /quota exhausted/);
    assert.match(seed, /Assistant: partial/);
    assert.match(seed, /New task:\nfinish/);
    assert.match(
        replacementTask('finish', 'old', '', 'final report'),
        /final report/,
    );
    assert.match(
        privateContentIn(
            replacementTask(
                'finish',
                'old',
                'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
            ),
        ) ?? '',
        /API key/,
    );
});

// The limits the Rust side enforces (src-tauri/src/delegate.rs) and the ones this side uses must be the same numbers.
test('the limits match the Rust side (delegate.rs)', () => {
    const rust = readFileSync(
        new URL('../../../src-tauri/src/delegate.rs', import.meta.url),
        'utf8',
    );
    const constant = (name: string) => {
        const match = rust.match(
            new RegExp(`const ${name}\\b[^=]*=\\s*([^;]+);`),
        );
        assert.ok(match, `delegate.rs has no constant ${name}`);
        return match[1];
    };
    const seconds = (expr: string) => {
        const from = expr.match(/from_secs\((\d+)\)/);
        return from ? Number(from[1]) : Number(expr.replace(/_/g, ''));
    };
    assert.equal(DEFAULT_TIMEOUT_S, seconds(constant('DEFAULT_TIMEOUT_S')));
    assert.equal(MIN_TIMEOUT_S, seconds(constant('MIN_TIMEOUT_S')));
    assert.equal(MAX_TIMEOUT_S, seconds(constant('MAX_TIMEOUT_S')));
    assert.equal(TASK_MAX_CHARS, seconds(constant('TASK_MAX_CHARS')));
    assert.equal(QUESTION_WAIT_MS, seconds(constant('QUESTION_WAIT')) * 1000);
    assert.equal(MAX_WORKERS, seconds(constant('MAX_PARALLEL_WORKERS')));
});

test('a worker never falls back to a free tier, a chat that is not a worker may', () => {
    const routes = [
        { key: 'claude', restricted: false },
        { key: 'free', restricted: true },
        { key: 'codex' },
    ];
    assert.deepEqual(
        routesForChat(routes, false).map((item) => item.key),
        ['claude', 'free', 'codex'],
    );
    assert.deepEqual(
        routesForChat(routes, true).map((item) => item.key),
        ['claude', 'codex'],
    );
});
