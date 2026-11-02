import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ts = createRequire(import.meta.url)('typescript');

/** The svelte runtime classes are plain collections here; reactivity is not what these tests check. */
const runtimeDefaults = { SvelteMap: Map, SvelteSet: Set, SvelteDate: Date };

/** Executes a real coordinator module with isolated native I/O; unconfigured imports fail on use. */
async function load(name, bindings, globals = {}) {
    const source = await readFile(
        new URL(
            `../../src/lib/chat/session/${name}.svelte.ts`,
            import.meta.url,
        ),
        'utf8',
    );
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
    const imports = new Map();
    for (const node of ast.statements) {
        // `export { a } from './x'` links like `import { a } from './x'`.
        if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            if (node.isTypeOnly || !node.exportClause) continue;
            if (!ts.isNamedExports(node.exportClause)) continue;
            imports.set(node.moduleSpecifier.text, [
                ...new Set([
                    ...(imports.get(node.moduleSpecifier.text) ?? []),
                    ...node.exportClause.elements
                        .filter((item) => !item.isTypeOnly)
                        .map((item) => (item.propertyName ?? item.name).text),
                ]),
            ]);
            continue;
        }
        if (!ts.isImportDeclaration(node) || node.importClause?.isTypeOnly)
            continue;
        const names = node.importClause?.namedBindings;
        if (!names || !ts.isNamedImports(names)) continue;
        imports.set(node.moduleSpecifier.text, [
            ...new Set([
                ...(imports.get(node.moduleSpecifier.text) ?? []),
                ...names.elements
                    .filter((item) => !item.isTypeOnly)
                    .map((item) => (item.propertyName ?? item.name).text),
            ]),
        ]);
    }
    const effect = Object.assign(() => {}, { root: () => {} });
    const context = vm.createContext({
        $state: (value) => value,
        $effect: effect,
        Date,
        Map,
        Set,
        crypto,
        performance,
        console,
        setTimeout: () => 0,
        clearTimeout() {},
        // Extra globals a module reads at run time (a test that needs real timers or `window` passes them).
        ...globals,
    });
    const code = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
        },
    }).outputText;
    const module = new vm.SourceTextModule(code, { context });
    await module.link((path) => {
        const names = imports.get(path);
        return new vm.SyntheticModule(
            names,
            function () {
                for (const name of names)
                    this.setExport(
                        name,
                        name in bindings
                            ? bindings[name]
                            : name in runtimeDefaults
                              ? runtimeDefaults[name]
                              : () => {
                                    throw new Error(
                                        `Unconfigured ${path}:${name}`,
                                    );
                                },
                    );
            },
            { context },
        );
    });
    await module.evaluate();
    return module.namespace;
}

export { load };
