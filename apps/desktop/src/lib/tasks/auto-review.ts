// Auto review (model popover > Auto review): after a turn of a main chat that changed files, AgentDeck itself hands the
// diff to the agent routed for the "review" task role, with a clean context. Its verdict comes back as any background
// report does: a FAIL puts the lead in owner mode (it fixes), and the fixing turn is reviewed again, up to the cap.
// Pure (no stores, no Tauri) so plain node can test it.
import type { Block } from '../chat/mock';

/** A turn that changed fewer files than this is not reviewed. */
export const AUTO_REVIEW_MIN_FILES = 2;
/** Reviews per user request: the first one, and one more after a fix. */
export const AUTO_REVIEW_ROUNDS = 2;
const REQUEST_MAX = 4000;
const PATHS_MAX = 40;

/** The files a reply's tool calls wrote, sub-agent work included, each once. */
export function changedPaths(blocks: Block[]): string[] {
    const paths = new Set<string>();
    const visit = (list: Block[]) => {
        for (const block of list) {
            if (block.kind !== 'command') continue;
            if (block.change?.path) paths.add(block.change.path);
            if (block.children) visit(block.children);
        }
    };
    visit(blocks);
    return [...paths];
}

export type AutoReviewInput = {
    /** The Auto review switch. */
    enabled: boolean;
    /** The Auto-orchestrate switch: off, AgentDeck hands nothing out. */
    orchestrate: boolean;
    /** The chat is a worker or a /btw side chat: only main chats are reviewed. */
    worker: boolean;
    /** The review task role has at least one route in Settings > Task roles. */
    hasRoute: boolean;
    paths: string[];
    /** Reviews already started for this user request. */
    rounds: number;
};

export function shouldAutoReview(input: AutoReviewInput): boolean {
    return (
        input.enabled &&
        input.orchestrate &&
        !input.worker &&
        input.hasRoute &&
        input.paths.length >= AUTO_REVIEW_MIN_FILES &&
        input.rounds < AUTO_REVIEW_ROUNDS
    );
}

/** The reviewer's task: the request and the changed files only, read-only, ending with a verdict the lead acts on. */
export function reviewBrief(
    request: string,
    paths: string[],
    round: number,
): string {
    const ask =
        request.length > REQUEST_MAX
            ? `${request.slice(0, REQUEST_MAX)}…`
            : request;
    const list = paths.slice(0, PATHS_MAX).map((path) => `- ${path}`);
    if (paths.length > PATHS_MAX)
        list.push(`- … and ${paths.length - PATHS_MAX} more`);
    return [
        `Review the changes another agent just made for the user's request (automatic review, round ${round} of ${AUTO_REVIEW_ROUNDS}).`,
        `User's request:\n${ask}`,
        `Changed files:\n${list.join('\n')}`,
        "Look at git diff (and git status for new files) of these files, and read the code around them as needed. Run the project's quick checks for them when they are cheap. Do not edit any file.",
        'Report only concrete problems that break the request or add a bug or regression, each with path:line. Style, risks and optional ideas go under OPEN, not as failures. Ignore anything the request did not ask for.',
        'In your Handoff, put VERDICT: FAIL only for a blocking problem, else VERDICT: PASS.',
    ].join('\n\n');
}
