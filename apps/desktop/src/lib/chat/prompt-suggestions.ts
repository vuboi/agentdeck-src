/** Most suggestions shown under one answer. */
export const MAX_PROMPT_SUGGESTIONS = 3;

/** Text of a suggestion as compared for duplicates: case, spacing and punctuation do not count. */
function comparable(text: string): string {
    return text
        .toLowerCase()
        .replace(/[\s\p{P}]+/gu, ' ')
        .trim();
}

/** Adds one suggestion to the list: empty and repeated ones are skipped, and the list keeps at most three. */
export function addPromptSuggestion(items: string[], text: string): string[] {
    const clean = text.trim();
    if (!clean) return items;
    const key = comparable(clean);
    if (items.some((item) => comparable(item) === key)) return items;
    return [...items, clean].slice(0, MAX_PROMPT_SUGGESTIONS);
}

/** Merges suggestions in order (the CLI's own first), without duplicates. */
export function mergePromptSuggestions(...lists: string[][]): string[] {
    return lists.flat().reduce(addPromptSuggestion, [] as string[]);
}
