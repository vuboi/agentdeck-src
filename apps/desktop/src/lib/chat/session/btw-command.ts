/**
 * `/btw` is switched off for now: it ran into the main chat and its model. The code stays so it can be redone; set this
 * back to true only after the redo is tested with the main chat, its model picker and its queue.
 */
export const BTW_ENABLED = true;

/** The question of a `/btw` line: '' for `/btw` alone, null when the line is not a `/btw` command. */
export function btwQuestionOf(text: string): string | null {
    const match = /^\/btw(?=\s|$)\s*([\s\S]*)$/.exec(text.trim());
    return match ? match[1].trim() : null;
}
