// Verification run before a release is committed and tagged: the same checks as AGENTS.md (cargo check, clippy with
// warnings denied, tests, svelte-check) plus the desktop node tests. Runs every step, prints a summary, exits 1 if any
// step failed. Usage: node scripts/release-check.mjs
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';

// whisper-rs-sys runs bindgen, which needs the MSVC and Windows SDK headers, and CMake must pick the installed Visual
// Studio. Only set when those folders exist and the caller has not set them, so other machines are not affected.
function windowsBuildEnvironment() {
    const programFiles =
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const buildTools = join(
        programFiles,
        'Microsoft Visual Studio',
        '2022',
        'BuildTools',
    );
    const msvcRoot = join(buildTools, 'VC', 'Tools', 'MSVC');
    const sdkRoot = join(programFiles, 'Windows Kits', '10', 'Include');
    const llvmRoot = join(
        process.env.ProgramFiles ?? 'C:\\Program Files',
        'LLVM',
        'lib',
        'clang',
    );
    const newest = (dir) =>
        existsSync(dir) ? readdirSync(dir).sort().reverse()[0] : undefined;
    const msvc = newest(msvcRoot);
    const sdk = newest(sdkRoot);
    const clang = newest(llvmRoot);
    if (!msvc || !sdk || !clang) return {};
    const env = {};
    if (!process.env.CMAKE_GENERATOR)
        env.CMAKE_GENERATOR = 'Visual Studio 17 2022';
    if (!process.env.BINDGEN_EXTRA_CLANG_ARGS) {
        // bindgen splits this value like a shell would: forward slashes keep backslashes from acting as escapes, and
        // spaces in the paths are escaped.
        const esc = (path) => path.replace(/\\/g, '/').replace(/ /g, '\\ ');
        const includes = [
            join(llvmRoot, clang, 'include'),
            join(msvcRoot, msvc, 'include'),
            join(sdkRoot, sdk, 'ucrt'),
            join(sdkRoot, sdk, 'um'),
            join(sdkRoot, sdk, 'shared'),
        ];
        env.BINDGEN_EXTRA_CLANG_ARGS = includes
            .map((path) => `-I${esc(path)}`)
            .join(' ');
    }
    return env;
}

if (isWindows) Object.assign(process.env, windowsBuildEnvironment());

const steps = [
    [
        'pnpm check (cargo check, clippy -D warnings, svelte-check)',
        'pnpm check',
    ],
    ['pnpm test (cargo test --workspace, desktop tests)', 'pnpm test'],
    [
        'desktop account-switch tests',
        'pnpm --filter desktop run test:account-switch',
    ],
];

const results = [];
for (const [label, command] of steps) {
    console.log(`\n=== ${label}\n$ ${command}`);
    let ok = true;
    try {
        execSync(command, { stdio: 'inherit' });
    } catch {
        ok = false;
    }
    results.push({ label, ok });
}

console.log('\n=== Summary');
for (const { label, ok } of results)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
const failed = results.filter((result) => !result.ok).length;
if (failed) {
    console.error(
        `\n${failed} step(s) failed. Fix them before committing the release.`,
    );
    process.exit(1);
}
console.log('\nAll release checks passed.');
