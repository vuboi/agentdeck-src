// Writes latest.json for the Tauri updater: one entry per platform, taken from the signed updater artifacts in dist/.
// Usage: node scripts/release-manifest.mjs <version> <notes-file> <dist-dir> <out-file>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [version, notesFile, dir, out] = process.argv.slice(2);
const downloads = `https://github.com/vuboi/agentdeck/releases/download/v${version}`;

const PLATFORMS = [
  { key: 'windows-x86_64', file: /_x64-setup\.exe$/ },
  { key: 'darwin-aarch64', file: /_aarch64\.app\.tar\.gz$/ },
  { key: 'darwin-x86_64', file: /_x64\.app\.tar\.gz$/ },
  { key: 'linux-x86_64', file: /_amd64\.AppImage$/ },
];

const files = readdirSync(dir);
const platforms = {};
for (const { key, file } of PLATFORMS) {
  const name = files.find((f) => file.test(f));
  if (!name) throw new Error(`no updater artifact for ${key}`);
  platforms[key] = {
    signature: readFileSync(join(dir, `${name}.sig`), 'utf8').trim(),
    url: `${downloads}/${name}`,
  };
}

const manifest = {
  version,
  notes: readFileSync(notesFile, 'utf8'),
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${out} for ${Object.keys(platforms).join(', ')}`);
