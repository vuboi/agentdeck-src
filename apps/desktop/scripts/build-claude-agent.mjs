import { copyFile, mkdir, chmod, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { build } from 'esbuild';

const desktop = resolve(import.meta.dirname, '..');
const output = join(desktop, 'build', 'claude-agent');
await mkdir(output, { recursive: true });
// Remove binaries produced by older builds: only the Agent SDK runner and Node ship with AgentDeck now.
await Promise.all([
    rm(join(output, 'claude.exe'), { force: true }),
    rm(join(output, 'claude'), { force: true }),
    rm(join(output, 'claude-agent-sdk-license.md'), { force: true }),
]);

await build({
    entryPoints: [join(desktop, 'src', 'agent', 'claude-sdk-runner.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    minify: true,
    outfile: join(output, 'runner.mjs'),
});

const nodeName = basename(process.execPath);
const nodePath = join(output, nodeName);
await copyFile(process.execPath, nodePath);
if (process.platform !== 'win32') await chmod(nodePath, 0o755);
