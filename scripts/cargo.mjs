import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';

const cargoBin = join(homedir(), '.cargo', 'bin');
const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ??
    'PATH';
const separator = process.platform === 'win32' ? ';' : ':';
let spawnFailed = false;
const env = {
    ...process.env,
    [pathKey]: [cargoBin, process.env[pathKey]].filter(Boolean).join(separator),
};

if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 =
        process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const installations = [
        {
            root: join(
                programFiles,
                'Microsoft Visual Studio',
                '18',
                'Community',
            ),
            generator: 'Visual Studio 18 2026',
        },
        {
            root: join(
                programFilesX86,
                'Microsoft Visual Studio',
                '2022',
                'BuildTools',
            ),
            generator: 'Visual Studio 17 2022',
        },
    ];
    const installation = installations.find(({ root }) =>
        existsSync(join(root, 'VC', 'Tools', 'MSVC')),
    );
    const llvmRoot = join(programFiles, 'LLVM');
    const clangRoot = join(llvmRoot, 'lib', 'clang');
    const clang = existsSync(clangRoot)
        ? readdirSync(clangRoot, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .sort()
              .at(-1)
        : undefined;
    const sdkRoot = join(programFilesX86, 'Windows Kits', '10', 'Include');
    const newest = (directory) =>
        existsSync(directory)
            ? readdirSync(directory).sort().at(-1)
            : undefined;
    const msvcRoot = installation
        ? join(installation.root, 'VC', 'Tools', 'MSVC')
        : undefined;
    const msvc = msvcRoot ? newest(msvcRoot) : undefined;
    const sdk = newest(sdkRoot);
    const llvmBin = join(llvmRoot, 'bin');

    if (existsSync(join(llvmBin, 'libclang.dll')))
        env.LIBCLANG_PATH ??= llvmBin;
    if (installation) {
        const command = `call "${join(installation.root, 'Common7', 'Tools', 'VsDevCmd.bat')}" -arch=x64 >nul && set`;
        const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
            encoding: 'utf8',
            windowsHide: true,
            windowsVerbatimArguments: true,
        });
        if (result.status === 0) {
            const developer = Object.fromEntries(
                result.stdout.split(/\r?\n/).flatMap((line) => {
                    const separatorIndex = line.indexOf('=');
                    return separatorIndex > 0
                        ? [
                              [
                                  line.slice(0, separatorIndex),
                                  line.slice(separatorIndex + 1),
                              ],
                          ]
                        : [];
                }),
            );
            const developerPathKey = Object.keys(developer).find(
                (key) => key.toLowerCase() === 'path',
            );
            if (developerPathKey)
                env[pathKey] = [developer[developerPathKey], env[pathKey]]
                    .filter(Boolean)
                    .join(';');
            for (const [key, value] of Object.entries(developer))
                if (key.toLowerCase() !== 'path') env[key] ??= value;
        }
        env.CMAKE_GENERATOR ??= installation.generator;
    }
    if (msvc && sdk && clang && !env.BINDGEN_EXTRA_CLANG_ARGS) {
        const escape = (path) => path.replace(/\\/g, '/').replace(/ /g, '\\ ');
        const includes = [
            join(clangRoot, clang, 'include'),
            join(msvcRoot, msvc, 'include'),
            join(sdkRoot, sdk, 'ucrt'),
            join(sdkRoot, sdk, 'um'),
            join(sdkRoot, sdk, 'shared'),
        ];
        env.BINDGEN_EXTRA_CLANG_ARGS = includes
            .map((path) => `-I${escape(path)}`)
            .join(' ');
    }
}

const child = spawn('cargo', process.argv.slice(2), {
    stdio: 'inherit',
    env,
});

child.on('error', (error) => {
    spawnFailed = true;
    console.error(`Failed to start cargo: ${error.message}`);
    process.exitCode = 1;
});
child.on('exit', (code, signal) => {
    if (!spawnFailed) process.exitCode = code ?? (signal ? 1 : 0);
});
