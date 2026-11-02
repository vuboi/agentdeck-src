import type { Message } from '../mock';

/**
 * Two copies of one turn are the same turn when they have the same role and the same text, and their times are
 * within this gap. The chat's copy of a reply and the provider's copy are both stamped when the turn starts, a few
 * seconds apart, so the gap only has to cover clock differences and a slow first block. Ids do not work here: a
 * Codex file numbers its messages by line (`codex-3`) and the same number recurs in each Codex file.
 */
const SAME_TURN_MS = 10 * 60_000;

/** Milliseconds of a message's time, from any ISO form (`Z`, an offset, fractions), or NaN without one. */
const timeOf = (message: Message): number =>
    message.at ? Date.parse(message.at) : Number.NaN;

const textOf = (message: Message): string =>
    message.blocks
        .flatMap((block) =>
            block.kind === 'response' ? [block.text.trim()] : [],
        )
        .join('\n')
        .trim();

/** Whether two times (NaN when unknown) are close enough to be the same turn. */
const closeTimes = (a: number, b: number): boolean =>
    Number.isNaN(a) || Number.isNaN(b) || Math.abs(a - b) < SAME_TURN_MS;

/**
 * The messages of one chat, read from several sources as one conversation: the messages of each native file, and
 * the turns of other agents kept beside them (`otherTurns`). The lists are given in priority order.
 *
 * - A message that is the same turn as one in an earlier list is dropped (the file's copy wins over a kept copy).
 *   Repeats inside one list are kept: a file can legitimately hold the same text twice.
 * - The rest is in time order, by instant. A message with no time keeps its place after the message before it in
 *   its own list. Ties keep the list order, then the position in the list.
 * - One list alone comes back unchanged: a single file is never re-sorted.
 */
export function mergeTranscripts(
    files: Message[][],
    others: Message[] = [],
): Message[] {
    const lists = [...files, others].filter((list) => list.length > 0);
    if (lists.length <= 1) return lists.length === 1 ? [...lists[0]] : [];
    const kept: { message: Message; list: number; key: number }[] = [];
    // The kept messages by role and text, so a message is only compared with those that could be its copy.
    const keptByText = new Map<string, { list: number; time: number }[]>();
    lists.forEach((list, index) => {
        // The time of the last message with a time: an untimed message takes it as its key.
        let last = Number.NEGATIVE_INFINITY;
        for (const message of list) {
            const time = timeOf(message);
            if (!Number.isNaN(time)) last = time;
            const text = textOf(message);
            const key = `${message.role}\n${text}`;
            const same = text ? (keptByText.get(key) ?? []) : [];
            const repeat = same.some(
                (item) => item.list < index && closeTimes(item.time, time),
            );
            if (repeat) continue;
            kept.push({
                message,
                list: index,
                key: Number.isNaN(time) ? last : time,
            });
            if (text) {
                const entries = keptByText.get(key) ?? [];
                entries.push({ list: index, time });
                keptByText.set(key, entries);
            }
        }
    });
    // Array sort is stable: equal keys in one list keep their order.
    kept.sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : a.list - b.list,
    );
    return kept.map((item) => item.message);
}
