import type { Block, Message } from '../mock';

/** The words of a message: its response blocks, joined. Two copies of one message share them. */
export const responseText = (message: Message) =>
    message.blocks
        .filter(
            (block): block is Extract<Block, { kind: 'response' }> =>
                block.kind === 'response',
        )
        .map((block) => block.text)
        .join('\n\n')
        .trim();

/** Whether two copies are one message: the same id, or the same speaker, words and (close) time. */
export function sameMessage(a: Message, b: Message): boolean {
    if (a.id === b.id) return true;
    const text = responseText(a);
    return (
        Boolean(text) &&
        a.role === b.role &&
        text === responseText(b) &&
        (!a.at ||
            !b.at ||
            Math.abs(Date.parse(a.at) - Date.parse(b.at)) < 10 * 60_000)
    );
}

/**
 * Where the newest messages of the file start inside a list held in memory: at the held copy of the file's first
 * message. -1 when the two do not overlap, so the held list is not this file's any more and must be read again.
 */
export function tailStart(held: Message[], fresh: Message[]): number {
    const first = fresh[0];
    if (!first) return -1;
    const byId = held.findIndex((message) => message.id === first.id);
    if (byId >= 0) return byId;
    // Without a shared id (a live copy, a re-imported copy) the match nearest the end is the one that belongs to the tail.
    return held.findLastIndex((message) => sameMessage(message, first));
}
