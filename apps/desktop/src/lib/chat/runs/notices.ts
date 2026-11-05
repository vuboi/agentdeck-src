// The text of the notices AgentDeck sends between runs: a file another run changed, a request the user sent to a side
// run, a worker's changed files for its parent. Pure, so node can test it. Plan: plan.md 6.2 (notices), 6.3 (triggers).

/** How many lines of a changed file a notice shows; the rest is named by its count. */
export const PREVIEW_LINES = 40;

/** The first lines of a text, with the count of the lines left out. */
export function previewText(text: string, lines = PREVIEW_LINES): string {
    const all = text.split('\n');
    if (all.length <= lines) return text;
    return `${all.slice(0, lines).join('\n')}\n… and ${all.length - lines} more line(s)`;
}

/** One notice about a file another run changed. `intent`: the request that run was working on, as the user wrote it. */
export function writeNotice(input: {
    path: string;
    byLabel: string;
    intent: string;
    after: string;
}): string {
    const intent = input.intent.trim().slice(0, 300);
    return [
        `[AgentDeck] A side run (${input.byLabel}) changed ${input.path} for the user's request: "${intent}".`,
        "It is the user's latest intent for this file. Re-read the file before you edit it, keep that change, and build on it. If your own plan conflicts with it, stop and ask the user instead of reverting it.",
        'New content (start):',
        previewText(input.after),
    ].join('\n');
}

/** The user wrote to a delegated worker in its own chat: only this line reaches the parent, not the message itself. */
export function workerUpdatedNotice(label: string): string {
    return `[AgentDeck] The user sent the worker "${label.trim().slice(0, 200)}" an update directly in its own chat. Its report will follow the updated request: wait for it, and do not delegate the same work again.`;
}

/** A background command the user stopped from the Work tray or the Sub agents panel: its process was ended. */
export function backgroundStoppedNotice(command: string): string {
    return `[AgentDeck] The user stopped the background command "${command.trim().slice(0, 300)}". Its process was ended, so no more output will come from it. Do not wait for it or start it again unless the user asks; carry on with the rest of your work and report as usual.`;
}

/** A message the user sent to a side run while this run is still working (plan 6.3, trigger 1). */
export function userAskedMeanwhileNotice(text: string): string {
    return `[AgentDeck] The user also asked meanwhile: "${text.trim().slice(0, 300)}". A side run handles it. Do not undo its result; keep working on your own task and read the files again before you edit them.`;
}

/** The files a worker changed, for the parent that waits for its report (plan 6.3, trigger 3). */
export function workerChangesNotice(label: string, paths: string[]): string {
    return [
        `[AgentDeck] Files changed by the worker "${label}" (from AgentDeck's change ledger, not from its own report):`,
        ...paths.map((path) => `- ${path}`),
        'Re-read these files before you rely on them.',
    ].join('\n');
}

/** The notices of one chat, as one block for its next prompt. Empty when there are none. */
export function noticeBlock(notices: readonly string[]): string {
    if (notices.length === 0) return '';
    return `${notices.join('\n\n')}\n\n`;
}

/** A file the user saved in the editor while runs work on it: the user's text is the newest intent (plan 6.3, trigger 6). */
export function userEditNotice(input: { path: string; after: string }): string {
    return [
        `[AgentDeck] The user edited ${input.path} by hand. That is the newest version of the file: re-read it before you edit it, and keep the user's text.`,
        'New content (start):',
        previewText(input.after),
    ].join('\n');
}
