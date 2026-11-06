import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// CodeGraph's platform package ships its own Node runtime (node.exe / node) plus the CLI in lib/. AgentDeck copies that
// folder into its resources, so `codegraph serve` / `explore` run without a global install.
const VERSION = '1.6.2';
const desktop = resolve(import.meta.dirname, '..');
const output = join(desktop, 'build', 'codegraph');
const platformName = `${process.platform}-${process.arch}`;
const packageName = `@colbymchenry/codegraph-${platformName}`;

const meta = await (
    await fetch(`https://registry.npmjs.org/${packageName}/${VERSION}`)
).json();
const tarball = meta?.dist?.tarball;
if (!tarball)
    throw new Error(`no codegraph build for ${platformName} at ${VERSION}`);

const work = join(tmpdir(), `codegraph-${VERSION}-${platformName}`);
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const archive = join(work, 'codegraph.tgz');
await writeFile(
    archive,
    Buffer.from(await (await fetch(tarball)).arrayBuffer()),
);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Windows 10+ ships bsdtar as System32\tar.exe; a POSIX tar on PATH cannot read "C:\" paths.
const tar =
    process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
const extracted = spawnSync(tar, ['-xzf', archive, '-C', output], {
    stdio: 'inherit',
});
if (extracted.status !== 0)
    throw new Error('tar failed while unpacking codegraph');

// npm packs everything under package/; move its contents up so output/node(.exe) and output/lib/ sit side by side.
const inner = join(output, 'package');
for (const entry of await readdir(inner)) {
    await rename(join(inner, entry), join(output, entry));
}
await rm(inner, { recursive: true, force: true });
await rm(work, { recursive: true, force: true });
console.log(`codegraph ${VERSION} (${platformName}) bundled at ${output}`);
