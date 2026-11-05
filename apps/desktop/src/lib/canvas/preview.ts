import type { ArtifactKind } from './fence';

export const ARTIFACT_CSP =
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:";

/** Builds the document used only by Canvas's sandboxed iframe; it grants no network or same-origin access. */
export function previewDocument(content: string, kind: ArtifactKind): string {
    let html = content;
    if (kind === 'svg' && !/^\s*<svg(?:\s|>)/i.test(html))
        html = `<svg xmlns="http://www.w3.org/2000/svg">${html}</svg>`;
    const policy = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
    if (!/^\s*<!doctype\s+html/i.test(html) && !/^\s*<html[\s>]/i.test(html))
        return `<!doctype html><html><head><meta charset="utf-8">${policy}</head><body>${html}</body></html>`;
    if (/<head(?:\s[^>]*)?>/i.test(html))
        return html.replace(/<head([^>]*)>/i, `<head$1>${policy}`);
    if (/<html(?:\s[^>]*)?>/i.test(html))
        return html.replace(/<html([^>]*)>/i, `<html$1><head>${policy}</head>`);
    return `<!doctype html><html><head>${policy}</head><body>${html}</body></html>`;
}
