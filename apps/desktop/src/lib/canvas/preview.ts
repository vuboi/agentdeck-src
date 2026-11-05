import type { ArtifactKind } from './fence';

export const ARTIFACT_CSP =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";

/** Builds a trusted CSP wrapper before content shown only in a scripts-only sandbox. */
export function previewDocument(content: string, kind: ArtifactKind): string {
    const artifact =
        kind === 'svg' && !/^\s*<svg(?:\s|>)/i.test(content)
            ? `<svg xmlns="http://www.w3.org/2000/svg">${content}</svg>`
            : content;
    const policy = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
    return `<!doctype html><html><head>${policy}</head><body>${artifact}</body></html>`;
}
