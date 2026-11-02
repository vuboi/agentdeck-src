/** Addresses that point at the same local Preview server should compare equal. */
function localHost(hostname: string): string {
    const host = hostname.toLowerCase();
    return host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host === '[::1]' ||
        host === '::1'
        ? '127.0.0.1'
        : host;
}

function normalized(address: string): string {
    try {
        const url = new URL(address);
        url.hostname = localHost(url.hostname);
        if (url.pathname === '') url.pathname = '/';
        return url.href;
    } catch {
        return address.trim();
    }
}

export function samePreviewAddress(left: string, right: string): boolean {
    return normalized(left) === normalized(right);
}

/** The server an address answers at (scheme, host, port), with the local host names as one: `http://127.0.0.1:4301`. */
export function serverOf(address: string): string {
    try {
        const url = new URL(address);
        url.hostname = localHost(url.hostname);
        return `${url.protocol}//${url.host}`;
    } catch {
        return address.trim();
    }
}

/**
 * The address of a page the Preview can open, or undefined: http or https with a host. A template such as
 * `http://localhost:{port}/` is not one (the server prints its real port), and neither is a sentence's trailing dot.
 */
export function pageAddress(text: string): string | undefined {
    const candidate = text.trim().replace(/[.,;:!?]+$/, '');
    if (/[\s{}<>"'`]/.test(candidate)) return undefined;
    try {
        const url = new URL(candidate);
        return (url.protocol === 'http:' || url.protocol === 'https:') &&
            url.hostname
            ? candidate
            : undefined;
    } catch {
        return undefined;
    }
}
