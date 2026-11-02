/** The question of a `/btw` line: '' for `/btw` alone, null when the line is not a `/btw` command. */
export function btwQuestionOf(text: string): string | null {
    const match = /^\/btw(?=\s|$)\s*([\s\S]*)$/.exec(text.trim());
    return match ? match[1].trim() : null;
}
