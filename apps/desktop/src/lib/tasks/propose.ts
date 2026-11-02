// The proposal of `propose_session` (the shape is checked in src-tauri/src/delegate.rs too): the card in the chat, the check
// of overlapping write scopes and dependencies between its tasks, and the worker calls a split starts. Pure: no store, no
// Tauri, so plain node can test it.
import { TASK_MAX_CHARS } from './delegate-task';

export type ProposedTask = {
    title: string;
    brief: string;
    writeScope: string[];
    dependsOn: string[];
};
export type Proposal = {
    title: string;
    tasks: ProposedTask[];
    isolation: 'worktree' | 'shared';
};
export type ProposalParse =
    { ok: true; proposal: Proposal } | { ok: false; error: string };

/** What the card keeps in its message: the choice made on it, and a note when a worker could not start. */
export type ProposalState = {
    state: 'split' | 'chat' | 'dismissed';
    note?: string;
};

const TITLE_MAX = 59;

const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The checks of the Rust side, in the same order and with the same limits. */
export function parseProposal(raw: unknown): ProposalParse {
    const fail = (error: string): ProposalParse => ({ ok: false, error });
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<
        string,
        unknown
    >;
    const title = text(input.title);
    if (!title) return fail('title is required: a short name for the split');
    if (Array.from(title).length > TITLE_MAX)
        return fail('title is longer than 59 characters');
    if (
        !Array.isArray(input.tasks) ||
        input.tasks.length < 2 ||
        input.tasks.length > 4
    )
        return fail('tasks takes 2 to 4 tasks');
    const tasks: ProposedTask[] = [];
    for (const [at, value] of input.tasks.entries()) {
        const item = (
            value && typeof value === 'object' ? value : {}
        ) as Record<string, unknown>;
        const number = at + 1;
        const taskTitle = text(item.title);
        if (!taskTitle) return fail(`task ${number}: title is required`);
        const brief = text(item.brief);
        if (!brief)
            return fail(
                `task ${number}: brief is required: the goal, paths and what to report back`,
            );
        if (Array.from(brief).length > TASK_MAX_CHARS)
            return fail(`task ${number}: brief is too long`);
        const scope = Array.isArray(item.write_scope)
            ? item.write_scope.map(text)
            : [];
        if (scope.length === 0 || scope.some((path) => !path))
            return fail(
                `task ${number}: write_scope is required: the files or folders it may change`,
            );
        let dependsOn: string[] = [];
        if (item.depends_on !== undefined && item.depends_on !== null) {
            if (
                !Array.isArray(item.depends_on) ||
                !item.depends_on.every((name) => text(name))
            )
                return fail(
                    `task ${number}: depends_on is a list of task titles`,
                );
            dependsOn = item.depends_on.map((name) => String(text(name)));
        }
        tasks.push({
            title: taskTitle,
            brief,
            writeScope: scope as string[],
            dependsOn,
        });
    }
    const isolation = text(input.isolation) ?? 'worktree';
    if (isolation !== 'worktree' && isolation !== 'shared')
        return fail('isolation must be worktree or shared');
    const titles = tasks.map((task) => task.title);
    if (new Set(titles).size !== titles.length)
        return fail('two tasks have the same title');
    for (const [at, task] of tasks.entries()) {
        for (const name of task.dependsOn) {
            if (!titles.includes(name))
                return fail(
                    `task ${at + 1} depends on "${name}", which is not a task of this split`,
                );
        }
    }
    // A cycle would wait forever: every task must be able to start after the ones it depends on.
    const seen = tasks.map(() => 0);
    const visit = (at: number): string | null => {
        if (seen[at] === 1) return tasks[at].title;
        if (seen[at] === 2) return null;
        seen[at] = 1;
        for (const name of tasks[at].dependsOn) {
            const cycle = visit(titles.indexOf(name));
            if (cycle) return cycle;
        }
        seen[at] = 2;
        return null;
    };
    for (const at of tasks.keys()) {
        const cycle = visit(at);
        if (cycle)
            return fail(`"${cycle}" depends on itself through other tasks`);
    }
    return {
        ok: true,
        proposal: {
            title,
            tasks,
            isolation: isolation as Proposal['isolation'],
        },
    };
}

/** The proposal of a `propose_session` call line (`name {json}`); a line cut off before its end is not one yet. */
export function proposalOfCommand(command: string): ProposalParse {
    const line = command.trim().replace(/^\S+\s*/, '');
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        return { ok: false, error: 'the call is still arriving' };
    }
    return parseProposal(raw);
}

/** A write scope as a folder path: slashes, case and a leading "./" do not count; "." (or empty) is the whole repository. */
function normScope(path: string): string {
    const folder = path
        .trim()
        .replace(/\\/g, '/')
        .replace(/^(\.\/)+/, '')
        .replace(/\/+$/, '')
        .toLowerCase();
    return folder === '' || folder === '.' || folder === '*' || folder === '**'
        ? '.'
        : folder;
}

function overlap(a: string, b: string): boolean {
    return (
        a === '.' ||
        b === '.' ||
        a === b ||
        b.startsWith(`${a}/`) ||
        a.startsWith(`${b}/`)
    );
}

function scopesOverlap(a: string[], b: string[]): boolean {
    return a.some((x) => b.some((y) => overlap(normScope(x), normScope(y))));
}

export type TaskMode = {
    title: string;
    /** parallel: it can run at once with the others; sequential: it waits for an earlier task. */
    mode: 'parallel' | 'sequential';
    /** Why it waits, one reason per line. */
    why: string[];
};
export type ProposalCheck = {
    tasks: TaskMode[];
    /** Every task can run at once: only then does the card offer the split. */
    parallel: boolean;
};

/** Which tasks can run in parallel: a task that depends on another, or writes where an earlier one writes, waits. */
export function checkProposal(proposal: Proposal): ProposalCheck {
    const tasks = proposal.tasks.map((task, at) => {
        const why: string[] = [];
        if (task.dependsOn.length)
            why.push(
                `depends on ${task.dependsOn.map((name) => `"${name}"`).join(', ')}`,
            );
        for (const earlier of proposal.tasks.slice(0, at))
            if (scopesOverlap(task.writeScope, earlier.writeScope))
                why.push(`writes the same files as "${earlier.title}"`);
        return {
            title: task.title,
            mode: why.length ? ('sequential' as const) : ('parallel' as const),
            why,
        };
    });
    return { tasks, parallel: tasks.every((task) => task.mode === 'parallel') };
}

export type CardActions = {
    visible: boolean;
    split: boolean;
    chat: boolean;
    dismiss: boolean;
};

/** The card's buttons: all three while nothing was chosen; Split only when every task can run in parallel. */
export function cardActions(
    check: ProposalCheck,
    state: ProposalState | undefined,
): CardActions {
    const open = !state;
    return {
        visible: state?.state !== 'dismissed',
        split: open && check.parallel,
        chat: open,
        dismiss: open,
    };
}

export type WorkerCall = {
    agent: string;
    model?: string;
    task: string;
    wait: false;
    isolation: 'worktree';
};

/** One worker call per task of a split: its own worktree, started in the background, with the parent's agent. */
export function workerCallsOf(
    proposal: Proposal,
    parent: { agent: string; model?: string },
): WorkerCall[] {
    return proposal.tasks.map((task) => ({
        agent: parent.agent,
        model: parent.model,
        task: `${task.brief}\n\nWrite only inside: ${task.writeScope.join(', ')}.`,
        wait: false,
        isolation: 'worktree',
    }));
}
