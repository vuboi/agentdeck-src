// Pure helpers for how a reply is laid out: commands folded into one group, status wording, durations.
import type { ZLoadingSpinner } from '@shival99/z-ui-svelte';
import { LOADER } from '../../app/platform/loaders';
import { kindOfCommand } from '../../tasks/delegate-task';
import { isRedundantAgentWait } from '../runs/run-lanes';
import type { Block } from '../mock';
import { ROLE_STATUS, roleOfCall } from '../../agents/task-roles';
import { askAsStep } from '../recovery/questions';
import {
    AGENT,
    ASK,
    CREATE,
    askSubject,
    EDIT,
    FETCH,
    ICON,
    detailOf,
    innerCommand,
    PAGE_ACT,
    PAGE_LOOK,
    PAGE_READ,
    PAGE_SCRIPT,
    READ,
    RUN,
    SEARCH,
    WEB_SEARCH,
    toolIcon,
} from './tool-kind';

export type CommandBlock = Extract<Block, { kind: 'command' }>;
export type ThinkingBlock = Extract<Block, { kind: 'thinking' }>;
export type PlanItem = {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
};
export type Segment =
    | { kind: 'plan'; items: PlanItem[] }
    | { kind: 'block'; block: Block }
    | /** Calls of delegate_task: each is a card of its own, not a line among the steps. */ {
          kind: 'tasks';
          items: CommandBlock[];
      }
    | /** Provider-native sub-agents/background tasks are first-class rows, not hidden in a tool detail. */ {
          kind: 'agent_activity';
          items: CommandBlock[];
      }
    | {
          kind: 'commands';
          items: CommandBlock[];
          /** Reasoning between the steps, folded into the group. */ thoughts: ThinkingBlock[];
      };

/** Consecutive commands become one group; everything else stays as it is. Reasoning with no text draws nothing,
 *  so it does not split a group either: the steps then count up on one line, as in Claude and Codex. Reasoning that
 *  has text and sits between steps (a local model thinks before nearly every one) joins the group too, as one
 *  "Thinking" entry inside it, instead of a box of its own between every two steps. */
/** The checklist of a TodoWrite / update_plan call, or null when the line is something else (or an old, cut-off one). */
export function planOf(command: string): PlanItem[] | null {
    if (!/^(TodoWrite|update_plan)\s/.test(command)) return null;
    try {
        const list: unknown = JSON.parse(argOf(command));
        if (!Array.isArray(list)) return null;
        return list.map((item: { content?: unknown; status?: unknown }) => ({
            content: String(item.content ?? ''),
            status:
                item.status === 'completed' || item.status === 'in_progress'
                    ? item.status
                    : 'pending',
        }));
    } catch {
        return null;
    }
}

type AskOf = (
    text: string,
) => { id: string; command: string; output: string } | null;

// The merged "Thinking" entry of several reasoning parts. It is kept per first part for as long as the same parts make it up,
// so the object (and the segment that holds it) stays the same while the text streams. Its text and streaming flag are
// read from the parts when they are rendered, so the text is not rebuilt by segments on every delta.
const mergedThinks = new WeakMap<
    ThinkingBlock,
    { parts: ThinkingBlock[]; block: ThinkingBlock }
>();
function mergedThinking(parts: ThinkingBlock[]): ThinkingBlock {
    const cached = mergedThinks.get(parts[0]);
    if (
        cached &&
        cached.parts.length === parts.length &&
        cached.parts.every((part, at) => part === parts[at])
    )
        return cached.block;
    const list = [...parts];
    const block: ThinkingBlock = {
        kind: 'thinking',
        get text() {
            return list
                .map((thought) => thought.text.trim())
                .filter(Boolean)
                .join('\n\n');
        },
        get streaming() {
            return list.some((thought) => thought.streaming);
        },
    };
    mergedThinks.set(list[0], { parts: list, block });
    return block;
}

// The step of an answer's questions, kept per answer block while its text stays the same: the answer is parsed once, not
// on every render. Only a finished answer gets here (see segments).
const askSteps = new WeakMap<
    Block,
    { text: string; step: CommandBlock | null }
>();
function askStepOf(
    block: Extract<Block, { kind: 'response' }>,
    askOf: AskOf,
): CommandBlock | null {
    const cached = askSteps.get(block);
    if (cached && cached.text === block.text) return cached.step;
    const ask = askOf(block.text);
    const step: CommandBlock | null = ask
        ? {
              kind: 'command',
              id: ask.id,
              command: ask.command,
              output: ask.output,
              status: 'ok',
          }
        : null;
    askSteps.set(block, { text: block.text, step });
    return step;
}

/** `askOf` is askAsStep; a parameter so a test can count the calls. */
export function segments(blocks: Block[], askOf: AskOf = askAsStep): Segment[] {
    const out: Segment[] = [];
    const showsAgentTasks = blocks.some(
        (block) => block.kind === 'command' && Boolean(block.task),
    );
    // Reasoning seen before its first step: it goes into the group that step starts.
    let pending: ThinkingBlock[] = [];
    // Reasoning with no step to join is one "Thinking" entry, however many parts it came in: Codex sends a dozen
    // reasoning items before an answer, and each used to be a box of its own.
    const flush = () => {
        if (pending.length === 1)
            out.push({ kind: 'block', block: pending[0] });
        else if (pending.length > 1)
            out.push({ kind: 'block', block: mergedThinking(pending) });
        pending = [];
    };
    for (const block of blocks) {
        if (block.kind === 'loading') continue;
        if (block.kind === 'thinking') {
            // Empty reasoning that is still streaming stays: its text is about to arrive. Reading `text` of a streaming block
            // here would make every delta of it run segments again.
            if (!block.streaming && !block.text.trim()) continue;
            const last = out.at(-1);
            if (last?.kind === 'commands') last.thoughts.push(block);
            else pending.push(block);
            continue;
        }
        if (block.kind !== 'command') {
            flush();
            out.push({ kind: 'block', block });
            // The questions in an answer stay in the activity list as a step to open, not only as the card that closes once answered.
            // Read once the answer is written out, as the question card is (ChatBlock): a streaming answer is not parsed per delta.
            const ask =
                block.kind === 'response' && !block.streaming
                    ? askStepOf(block, askOf)
                    : null;
            if (ask) out.push({ kind: 'commands', items: [ask], thoughts: [] });
            continue;
        }
        // `Agent activity` already shows each child, status, and result. Codex's trailing `wait N agent(s)` call is only
        // a repeated count/placeholder in that case, so do not print a second command group for it.
        if (isRedundantAgentWait(block.command, showsAgentTasks)) continue;
        if (kindOfCommand(block.command) === 'delegate_task') {
            flush();
            const shown = out.at(-1);
            if (shown?.kind === 'tasks') shown.items.push(block);
            else out.push({ kind: 'tasks', items: [block] });
            continue;
        }
        if (block.task) {
            flush();
            const shown = out.at(-1);
            if (shown?.kind === 'agent_activity') shown.items.push(block);
            else out.push({ kind: 'agent_activity', items: [block] });
            continue;
        }
        const plan = planOf(block.command);
        if (plan) {
            // One checklist per reply: a later call updates it where it first appeared.
            const shown = out.find((part) => part.kind === 'plan');
            if (shown?.kind === 'plan') shown.items = plan;
            else {
                flush();
                out.push({ kind: 'plan', items: plan });
            }
            continue;
        }
        const last = out.at(-1);
        if (last?.kind === 'commands') last.items.push(block);
        else {
            out.push({ kind: 'commands', items: [block], thoughts: pending });
            pending = [];
        }
    }
    flush();
    return out;
}

const sameItems = <T>(a: T[], b: T[]) =>
    a.length === b.length && a.every((item, at) => item === b[at]);

/** Whether a segment of the last render still describes the same things as the new one. */
function unchanged(old: Segment, next: Segment): boolean {
    if (old.kind === 'block' && next.kind === 'block')
        return old.block === next.block;
    if (old.kind === 'plan' && next.kind === 'plan')
        return sameItems(old.items, next.items);
    if (old.kind === 'commands' && next.kind === 'commands')
        return (
            sameItems(old.items, next.items) &&
            sameItems(old.thoughts, next.thoughts)
        );
    if (old.kind === 'tasks' && next.kind === 'tasks')
        return sameItems(old.items, next.items);
    if (old.kind === 'agent_activity' && next.kind === 'agent_activity')
        return sameItems(old.items, next.items);
    return false;
}

/** The new segments, with the object of the old one wherever it is still the same. A streamed delta changes the text of one
 *  block, so every segment before it comes back as the same object and its group does not render again. Same position only. */
export function reuseSegments(prev: Segment[], next: Segment[]): Segment[] {
    return next.map((segment, at) =>
        prev[at] && unchanged(prev[at], segment) ? prev[at] : segment,
    );
}

/** The tool name of a `Name  argument` command line; an MCP name (`mcp__agentdeck__browser_click`) is shown without its server. */
export const toolOf = (command: string) =>
    (command.split(/\s+/, 1)[0] ?? '').replace(/^mcp__.*__/, '');
/** The argument part of the line. */
export const argOf = (command: string) =>
    command.slice(toolOf(command).length).trim();

// The tool names of each agent and their icons are shared with the Audit log (tool-kind.ts).

const basename = (path: string) =>
    path
        .split(/[\\/]+/)
        .filter(Boolean)
        .at(-1) ?? path;

export type Step = {
    /** A small icon for the kind of step (see `iconOf`). */
    icon: string;
    /** Small muted word: "Ran", "Created", "Read". */
    verb: string;
    /** What it was done to: the command, the file name, the pattern. */
    subject: string;
    /** What a file change did. Only the non-zero parts show. */
    counts?: Counts;
};

/** Lines added and removed, and files created and deleted. */
export type Counts = {
    added: number;
    removed: number;
    created: number;
    deleted: number;
};

/** The icon of a step, by what it did (tool-kind.ts): a file change by the change, a delegation or a skill loaded through an
 *  MCP tool by what the call does, the rest by the tool's name. */
export function iconOf(item: CommandBlock): string {
    const tool = toolOf(item.command);
    if (item.change)
        return ICON[
            tool === 'Delete'
                ? 'delete'
                : item.change.create === true
                  ? 'create'
                  : 'edit'
        ];
    const delegation = kindOfCommand(item.command);
    if (delegation === 'delegate_task') return ICON.mention;
    if (delegation) return ICON.team;
    if (/^load_skill\b/.test(detailOf(argOf(item.command)))) return ICON.skill;
    return toolIcon(tool);
}

/** The icon of a group's header: the step running now, else the kind of step the group did most (first seen wins a tie). */
export function groupIcon(items: CommandBlock[]): string {
    const running = items.findLast((item) => item.status === 'running');
    if (running) return iconOf(running);
    const counts = new Map<string, number>();
    for (const item of items)
        counts.set(iconOf(item), (counts.get(iconOf(item)) ?? 0) + 1);
    let best: string = ICON.tool;
    let most = 0;
    for (const [icon, count] of counts)
        if (count > most) [best, most] = [icon, count];
    return best;
}

/** One row of the activity list. Wording follows the tool; a running step says "Running", a failed one "Failed". */
export function describeStep(item: CommandBlock): Step {
    return { icon: iconOf(item), ...wordsOf(item) };
}

function wordsOf(item: CommandBlock): Omit<Step, 'icon'> {
    const tool = toolOf(item.command);
    const running = item.status === 'running';
    const verbs = (done: string, doing: string) =>
        item.status === 'fail' ? 'Failed' : running ? doing : done;
    if (item.change) {
        const removed = tool === 'Delete';
        const created = !removed && item.change.create === true;
        return {
            verb: verbs(
                removed ? 'Deleted' : created ? 'Created' : 'Edited',
                removed ? 'Deleting' : created ? 'Creating' : 'Editing',
            ),
            subject: basename(item.change.path),
            counts: {
                added: item.change.added,
                removed: item.change.removed,
                created: created ? 1 : 0,
                deleted: removed ? 1 : 0,
            },
        };
    }
    // Some agents send the arguments as JSON (`view {"path":"…"}`): the main one is what the step is about.
    const raw = argOf(item.command);
    const subject =
        RUN.test(tool) ||
        CREATE.test(tool) ||
        EDIT.test(tool) ||
        READ.test(tool) ||
        SEARCH.test(tool) ||
        FETCH.test(tool)
            ? detailOf(raw)
            : raw;
    if (RUN.test(tool))
        return {
            verb: verbs('Ran', 'Running'),
            subject: innerCommand(subject),
        };
    if (CREATE.test(tool))
        return {
            verb: verbs('Created', 'Creating'),
            subject: basename(subject),
        };
    if (EDIT.test(tool))
        return { verb: verbs('Edited', 'Editing'), subject: basename(subject) };
    if (READ.test(tool))
        return { verb: verbs('Read', 'Reading'), subject: basename(subject) };
    if (SEARCH.test(tool))
        return { verb: verbs('Searched', 'Searching'), subject };
    if (FETCH.test(tool))
        return { verb: verbs('Fetched', 'Fetching'), subject };
    if (ASK.test(tool))
        return { verb: verbs('Asked', 'Asking'), subject: askSubject(raw) };
    if (AGENT.test(tool))
        return { verb: verbs('Ran agent', 'Running agent'), subject };
    if (PAGE_ACT.test(tool))
        return {
            verb: verbs('Interacted with page', 'Interacting with page'),
            subject: '',
        };
    if (PAGE_SCRIPT.test(tool))
        return {
            verb: verbs('Ran page script', 'Running page script'),
            subject: '',
        };
    if (tool === 'browser_open')
        return { verb: verbs('Opened a page', 'Opening a page'), subject: '' };
    if (tool === 'browser_serve')
        return {
            verb: verbs('Started a server', 'Starting a server'),
            subject: '',
        };
    if (PAGE_LOOK.test(tool))
        return {
            verb: verbs('Took a screenshot', 'Taking a screenshot'),
            subject: '',
        };
    if (PAGE_READ.test(tool))
        return { verb: verbs('Found on page', 'Finding on page'), subject: '' };
    if (tool === 'Plan')
        return { verb: verbs('Planned', 'Planning'), subject: '' };
    const delegation = kindOfCommand(item.command);
    if (delegation === 'delegate_task') {
        const role = roleOfCall(item.command);
        return role
            ? {
                  verb: verbs(
                      ROLE_STATUS[role].done,
                      ROLE_STATUS[role].running,
                  ),
                  subject: '',
              }
            : {
                  verb: verbs('Messaged an agent', 'Messaging an agent'),
                  subject: '',
              };
    }
    if (delegation === 'list_agents')
        return {
            verb: verbs('Listed the agents', 'Listing the agents'),
            subject: '',
        };
    if (delegation === 'task_status')
        return {
            verb: verbs('Checked a task', 'Checking a task'),
            subject: '',
        };
    if (delegation === 'task_stop')
        return {
            verb: verbs('Stopped a task', 'Stopping a task'),
            subject: '',
        };
    if (tool === 'PackageInfo')
        return {
            verb: verbs('Checked the package', 'Checking the package'),
            subject,
        };
    if (/^code_/.test(tool))
        return {
            verb: verbs(
                'Looked up in the code index',
                'Looking up in the code index',
            ),
            subject: `${tool.slice(5)} ${subject}`.trim(),
        };
    // Any other tool (an MCP tool, say): its name without the server (Codex writes `server.tool`) and its main argument.
    return {
        verb: verbs('Used', 'Using'),
        subject:
            `${tool.split('.').at(-1) || tool} ${detailOf(subject)}`.trim(),
    };
}

/** A step as one short line: "Running pnpm exec svelte-check", "Editing Chat.svelte", "Using officecli load_skill word".
 *  Only its first line, cut at `max`; the row's own width cuts it further. */
export function stepLine(item: CommandBlock, max = 90): string {
    const step = describeStep(item);
    const subject = step.subject.split('\n')[0].trim();
    const cut =
        subject.length > max ? `${subject.slice(0, max - 1)}…` : subject;
    return [step.verb, cut].filter(Boolean).join(' ');
}

const plural = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`;

/** "Created 2 files, ran 8 commands": what a group of steps did, files first. */
export function summarize(items: CommandBlock[]): string {
    const isDelete = (item: CommandBlock) => toolOf(item.command) === 'Delete';
    const paths = (keep: (item: CommandBlock) => boolean) =>
        new Set(
            items
                .filter((item) => item.change && keep(item))
                .map((item) => item.change!.path),
        ).size;
    const created = paths(
        (item) => !isDelete(item) && item.change!.create === true,
    );
    const edited = paths(
        (item) => !isDelete(item) && item.change!.create !== true,
    );
    const deleted = paths(isDelete);
    const ran = items.filter(
        (item) => !item.change && RUN.test(toolOf(item.command)),
    ).length;
    // Steps that only read or look something up: each kind says what it did, the rest is a plain tool call.
    const kinds = items
        .filter((item) => !item.change && !RUN.test(toolOf(item.command)))
        .map((item) => toolOf(item.command));
    const read = kinds.filter((tool) => READ.test(tool)).length;
    const searched = kinds.filter((tool) => SEARCH.test(tool)).length;
    const fetched = kinds.filter((tool) => FETCH.test(tool)).length;
    const asked = kinds.filter((tool) => ASK.test(tool)).length;
    const other = kinds.length - read - searched - fetched - asked;
    const parts = [
        created && `created ${plural(created, 'file')}`,
        edited && `edited ${plural(edited, 'file')}`,
        deleted && `deleted ${plural(deleted, 'file')}`,
        ran && `ran ${plural(ran, 'command')}`,
        read && `read ${plural(read, 'file')}`,
        searched && `searched ${plural(searched, 'time', 'times')}`,
        fetched && `fetched ${plural(fetched, 'page')}`,
        asked && `asked ${plural(asked, 'question')}`,
        other && `used ${plural(other, 'tool')}`,
    ].filter(Boolean) as string[];
    const text = parts.join(', ');
    return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Lines and files a group changed, or null when it changed no files. */
export function totalChange(items: CommandBlock[]): Counts | null {
    const changesByPath = new Map<
        string,
        { item: CommandBlock; added: number; removed: number }
    >();
    for (const item of items) {
        if (!item.change) continue;
        const current = changesByPath.get(item.change.path);
        if (item.change.cumulative === false) {
            changesByPath.set(item.change.path, {
                item,
                added: (current?.added ?? 0) + item.change.added,
                removed: (current?.removed ?? 0) + item.change.removed,
            });
        } else {
            changesByPath.set(item.change.path, {
                item,
                added: item.change.added,
                removed: item.change.removed,
            });
        }
    }
    const changes = [...changesByPath.values()];
    if (changes.length === 0) return null;
    const isDelete = (item: CommandBlock) => toolOf(item.command) === 'Delete';
    return {
        added: changes.reduce((sum, entry) => sum + entry.added, 0),
        removed: changes.reduce((sum, entry) => sum + entry.removed, 0),
        created: changes.filter(
            (entry) =>
                !isDelete(entry.item) && entry.item.change!.create === true,
        ).length,
        deleted: changes.filter((entry) => isDelete(entry.item)).length,
    };
}

/** What a running step is doing, in a few words: the kind of work, not its details (the step line above has those). */
function activityOf(item: CommandBlock): {
    label: string;
    spinner: ZLoadingSpinner;
} {
    const tool = toolOf(item.command);
    if (item.change || EDIT.test(tool)) {
        if (tool === 'Delete')
            return { label: 'Deleting file', spinner: LOADER.action };
        if (item.change?.create === true || (CREATE.test(tool) && !item.change))
            return { label: 'Creating file', spinner: LOADER.action };
        return { label: 'Editing file', spinner: LOADER.action };
    }
    if (RUN.test(tool))
        return { label: 'Running command', spinner: LOADER.command };
    if (READ.test(tool))
        return { label: 'Reading file', spinner: LOADER.check };
    if (WEB_SEARCH.test(tool))
        return { label: 'Searching the web', spinner: LOADER.fetch };
    if (SEARCH.test(tool))
        return { label: 'Searching files', spinner: LOADER.check };
    if (FETCH.test(tool))
        return { label: 'Fetching page', spinner: LOADER.fetch };
    if (ASK.test(tool))
        return { label: 'Waiting for your answer', spinner: LOADER.background };
    if (AGENT.test(tool))
        return { label: 'Running agent', spinner: LOADER.background };
    const delegation = kindOfCommand(item.command);
    if (delegation === 'delegate_task') {
        const role = roleOfCall(item.command);
        return {
            label: role ? ROLE_STATUS[role].running : 'Waiting for an agent',
            spinner: LOADER.background,
        };
    }
    if (delegation)
        return { label: 'Checking agents', spinner: LOADER.background };
    if (PAGE_ACT.test(tool))
        return { label: 'Interacting with page', spinner: LOADER.action };
    if (PAGE_SCRIPT.test(tool))
        return { label: 'Running page script', spinner: LOADER.command };
    if (PAGE_LOOK.test(tool))
        return { label: 'Taking screenshot', spinner: LOADER.check };
    if (PAGE_READ.test(tool))
        return { label: 'Reading page', spinner: LOADER.check };
    if (tool === 'browser_open')
        return { label: 'Opening page', spinner: LOADER.fetch };
    if (tool === 'browser_serve')
        return { label: 'Starting server', spinner: LOADER.command };
    if (tool === 'Plan') return { label: 'Planning', spinner: LOADER.thinking };
    return {
        label: `Using ${tool.split('.').at(-1) || 'tool'}`,
        spinner: LOADER.command,
    };
}

/** What the agent is doing right now, and the loader that goes with it. A running step wins over everything: a reasoning or
 *  text delta that arrives while a tool runs must not turn the line into "Thinking". */
export function liveState(blocks: Block[]): {
    label: string;
    spinner: ZLoadingSpinner;
} {
    if (
        blocks.some(
            (block) => block.kind === 'permission' && block.state === 'pending',
        )
    )
        return { label: 'Waiting for approval', spinner: LOADER.background };
    const running = blocks
        .filter(
            (block): block is CommandBlock =>
                block.kind === 'command' && block.status === 'running',
        )
        .at(-1);
    if (running) return activityOf(running);
    const last = blocks.filter((block) => block.kind !== 'loading').at(-1);
    if (last?.kind === 'thinking' && last.streaming)
        return { label: 'Reasoning', spinner: LOADER.reasoning };
    if (last?.kind === 'response' && last.streaming)
        return { label: 'Writing reply', spinner: LOADER.writing };
    // Between steps, or before the first token: the model is deciding what to do next.
    return { label: 'Thinking', spinner: LOADER.thinking };
}

/** `24s`, `1m 05s`. */
export function elapsed(ms: number): string {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** The text of the answer, for the copy button. */
export function answerText(blocks: Block[]): string {
    return blocks
        .filter((block) => block.kind === 'response')
        .map((block) => block.text)
        .join('\n\n');
}

/** `4 minutes ago`. */
export function ago(iso: string, now: number): string {
    const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
    if (Number.isNaN(seconds)) return '';
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    const steps: [Intl.RelativeTimeFormatUnit, number][] = [
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
    ];
    for (const [unit, size] of steps) {
        if (Math.abs(seconds) >= size)
            return rtf.format(Math.round(seconds / size), unit);
    }
    return 'just now';
}

/** `Oct 22, 2026, 11:17 AM`. */
export const fullDate = (iso: string) =>
    new Date(iso).toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
    });
