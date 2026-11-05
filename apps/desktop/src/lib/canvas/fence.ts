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

/** Finds complete, plain fenced artifact blocks in a finished assistant reply. */
export function artifactFences(source: string): ArtifactFence[] {
    const found: ArtifactFence[] = [];
    const pattern =
        /^```agentdeck-artifact\s+([^\r\n]*)\r?\n([\s\S]*?)^```\s*$/gm;
    for (const match of source.matchAll(pattern)) {
        const title = /(?:^|\s)title="([^"\r\n]{1,160})"/.exec(match[1])?.[1];
        const kind = /(?:^|\s)kind="(html|markdown|svg|code)"/.exec(
            match[1],
        )?.[1] as ArtifactKind | undefined;
        if (!title || !kind || match.index === undefined) continue;
        found.push({
            title,
            kind,
            content: match[2].replace(/\r?\n$/, ''),
            start: match.index,
            end: match.index + match[0].length,
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
