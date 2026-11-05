export type ArtifactKind = 'html' | 'markdown' | 'svg' | 'code';

export type ArtifactFence = {
    title: string;
    kind: ArtifactKind;
    content: string;
    start: number;
    end: number;
};

/** Durable identity for a finished artifact fence in a persisted chat message. */
export function artifactFenceSourceKey(
    chatId: string,
    messageId: string,
    blockIndex: number,
    offset: number,
): string {
    return JSON.stringify([chatId, messageId, blockIndex, offset]);
}

/** Whether an agent command line names AgentDeck's artifact tools. */
export function isArtifactCommand(command: string): boolean {
    return /^(?:artifact_(?:create|update)|mcp__agentdeck__artifact_(?:create|update)|agentdeck\.artifact_(?:create|update))\s/.test(
        command,
    );
}

/** Finds complete, plain fenced artifact blocks in a finished assistant reply. A fence written inside another code fence
 *  (a reply quoting the format) is only an example and is skipped. */
export function artifactFences(source: string): ArtifactFence[] {
    const found: ArtifactFence[] = [];
    const lines = /^(`{3,}|~{3,})([^\r\n]*)$/gm;
    let open: {
        marker: string;
        start: number;
        body: number;
        header: string | null;
    } | null = null;
    for (const match of source.matchAll(lines)) {
        const [line, marker, info] = match;
        const at = match.index ?? 0;
        if (!open) {
            const header = /^agentdeck-artifact\s+(.*)$/.exec(info.trim());
            open = {
                marker,
                start: at,
                body: source.indexOf('\n', at) + 1 || source.length,
                header: marker === '```' && header ? header[1] : null,
            };
            continue;
        }
        if (
            marker[0] !== open.marker[0] ||
            marker.length < open.marker.length ||
            info.trim()
        )
            continue;
        const header = open.header;
        const body = open.body;
        const start = open.start;
        open = null;
        if (header === null) continue;
        const title = /(?:^|\s)title="([^"\r\n]{1,160})"/.exec(header)?.[1];
        const kind = /(?:^|\s)kind="(html|markdown|svg|code)"/.exec(
            header,
        )?.[1] as ArtifactKind | undefined;
        if (!title || !kind) continue;
        found.push({
            title,
            kind,
            content: source.slice(body, at).replace(/\r?\n$/, ''),
            start,
            end: at + line.length,
        });
    }
    return found;
}

/** Replaces parsed fences from the end so earlier source offsets remain stable. */
export function withoutArtifactFences(
    source: string,
    fences = artifactFences(source),
): string {
    let result = source;
    for (const fence of [...fences].reverse())
        result = result.slice(0, fence.start) + result.slice(fence.end);
    return result.trim();
}
