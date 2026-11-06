// Pure reducer: one agent event applied to the blocks of the reply it belongs to.
// Kept free of stores and Tauri so it can be unit-tested with plain node.
//
// A block is "streaming" while the CLI is still writing it: only the last thinking or response block can be.
// Starting any other block, or ending the turn, closes it. A command stays "running" until the turn ends.

import type { Block, Message, TaskRecord } from './mock';
import type { AgentEvent } from './agent';

export type ReplyUpdate = {
    blocks: Block[];
    /** A provider notice to show on the live line, set by a `notice` event and cleared by any other event. */
    notice?: string;
    /** The turn is over (done or error): stop waiting, clear the live reply. */
    finished: boolean;
    /** The CLI's conversation id, when the turn reports one. */
    agentSession?: string;
};

/** Stop every streaming block; with `endTurn`, also settle running commands. */
function close(
    blocks: Block[],
    endTurn: boolean,
    endStatus: 'ok' | 'fail' = 'ok',
) {
    for (const block of blocks) {
        if (block.kind === 'thinking' && block.streaming)
            block.endedAt = Date.now();
        if (block.kind === 'thinking' || block.kind === 'response')
            block.streaming = false;
        if (endTurn && block.kind === 'command' && block.status === 'running')
            block.status = endStatus;
        if (endTurn && block.kind === 'command' && block.children)
            close(block.children, true, endStatus);
    }
}

/** The tool call `id`, at any depth: a sub-agent's own calls can start sub-agents. */
function findCommand(
    blocks: Block[],
    id: string,
): Extract<Block, { kind: 'command' }> | undefined {
    for (const block of blocks) {
        if (block.kind !== 'command') continue;
        if (block.id === id) return block;
        const inner = block.children
            ? findCommand(block.children, id)
            : undefined;
        if (inner) return inner;
    }
    return undefined;
}

type CommandBlock = Extract<Block, { kind: 'command' }>;
type TaskEvent = Extract<AgentEvent, { kind: 'task' }>;

/** A task that has ended: its late events do not reopen it. */
const ENDED = new Set<TaskRecord['status']>([
    'done',
    'failed',
    'stopped',
    'closed',
]);

/** The card's task, from all the tasks of its call: running while any runs; otherwise failed if one failed, stopped if
 *  one was stopped, else done. Its label and summary are the last ones given. */
function cardTask(tasks: Record<string, TaskRecord>): TaskRecord {
    const all = Object.values(tasks);
    const running = all.filter((task) => !ENDED.has(task.status));
    let status: TaskRecord['status'] = 'done';
    if (running.length > 0) {
        status = running.some((task) => task.status === 'progress')
            ? 'progress'
            : 'started';
    } else if (all.some((task) => task.status === 'failed')) {
        status = 'failed';
    } else if (all.some((task) => task.status === 'stopped')) {
        status = 'stopped';
    } else if (all.some((task) => task.status === 'closed')) {
        status = 'closed';
    }
    const starts = all.flatMap((task) =>
        task.startedAt === undefined ? [] : [task.startedAt],
    );
    const ends = all.flatMap((task) =>
        task.endedAt === undefined ? [] : [task.endedAt],
    );
    return {
        status,
        label: all.findLast((task) => task.label)?.label,
        summary: all.findLast((task) => task.summary)?.summary,
        tools: all.reduce<number | undefined>(
            (sum, task) =>
                task.tools === undefined ? sum : (sum ?? 0) + task.tools,
            undefined,
        ),
        startedAt: starts.length > 0 ? Math.min(...starts) : undefined,
        endedAt:
            running.length === 0 && ends.length > 0
                ? Math.max(...ends)
                : undefined,
    };
}

/** A teammate's card is named by the teammate: "teammate-one · general-purpose: Write ALPHA". */
function teammateLabel(
    teammate: string | undefined,
    label: string | null | undefined,
): string | undefined {
    if (!label) return undefined;
    return teammate ? `${teammate} · ${label}` : label;
}

/** Applies a task event to the background call it belongs to. Each task keeps its own record, so a call that started
 *  several (one spawn, several agents) shows each, and the card's task is the whole. A task that has ended is not
 *  reopened by its late events (a finished worker, a stopped one). */
function applyTaskEvent(call: CommandBlock, event: TaskEvent) {
    // A card drawn from history has its ended task but no record per task: its late events do not reopen it either.
    if (!call.tasks && call.task && ENDED.has(call.task.status)) return;
    const tasks = (call.tasks ??= {});
    const before = tasks[event.id];
    if (before && ENDED.has(before.status)) return;
    const now = Date.now();
    tasks[event.id] = {
        status: event.status,
        // Set once, when the task first shows: the activity card counts from here.
        startedAt: before?.startedAt ?? now,
        endedAt: ENDED.has(event.status) ? now : undefined,
        label: teammateLabel(call.teammate, event.label) ?? before?.label,
        summary: event.summary ?? before?.summary,
        tools: event.tools ?? before?.tools,
    };
    call.task = cardTask(tasks);
}

/** Ends the tasks of a call that are still open, as stopped: the user stopped the chat's background work. */
export function stopCallTasks(call: CommandBlock) {
    const now = Date.now();
    if (call.tasks) {
        for (const task of Object.values(call.tasks)) {
            if (ENDED.has(task.status)) continue;
            task.status = 'stopped';
            task.endedAt = now;
        }
        call.task = cardTask(call.tasks);
    } else if (call.task && !ENDED.has(call.task.status)) {
        call.task = { ...call.task, status: 'stopped', endedAt: now };
    }
}

/** Ends the open tasks of a call as closed: AgentDeck closed while they ran (see `closeRestoredTasks`). */
function closeCallTasks(call: CommandBlock) {
    const now = Date.now();
    if (call.tasks) {
        for (const task of Object.values(call.tasks)) {
            if (ENDED.has(task.status)) continue;
            task.status = 'closed';
            task.endedAt = now;
        }
        call.task = cardTask(call.tasks);
    } else if (call.task && !ENDED.has(call.task.status)) {
        call.task = { ...call.task, status: 'closed', endedAt: now };
    }
}

/** A restored chat's background tasks that were still open: the app closed while they ran. Closes them (in place) and
 *  returns how many calls were closed. */
export function closeRestoredTasks(blocks: Block[]): number {
    let closed = 0;
    for (const block of blocks) {
        if (block.kind !== 'command') continue;
        if (block.task && !ENDED.has(block.task.status)) {
            closeCallTasks(block);
            closed++;
        }
        if (block.children) closed += closeRestoredTasks(block.children);
    }
    return closed;
}

/** Child events that came before the call they belong to was drawn (the call's start is late or was lost). They wait
 *  for it, at most ORPHAN_LIMIT in all and for ORPHAN_MS each; what expires is logged, never drawn in the main answer. */
const ORPHAN_LIMIT = 200;
const ORPHAN_MS = 60_000;
const orphans = new Map<string, { event: AgentEvent; at: number }[]>();

function expireOrphans(now: number) {
    for (const [parent, list] of orphans) {
        const fresh = list.filter((held) => now - held.at < ORPHAN_MS);
        if (fresh.length < list.length)
            console.warn(
                `[agent] ${list.length - fresh.length} sub-agent event(s) of call ${parent} expired: its card never came`,
            );
        if (fresh.length > 0) orphans.set(parent, fresh);
        else orphans.delete(parent);
    }
}

function holdOrphan(parent: string, event: AgentEvent) {
    const now = Date.now();
    expireOrphans(now);
    const list = orphans.get(parent) ?? [];
    list.push({ event, at: now });
    orphans.set(parent, list);
    let total = 0;
    for (const held of orphans.values()) total += held.length;
    const oldest = orphans.keys().next().value;
    if (total > ORPHAN_LIMIT && oldest !== undefined) {
        // The oldest call's first event goes: the buffer keeps to its limit.
        const dropped = orphans.get(oldest) ?? [];
        dropped.shift();
        console.warn(
            `[agent] more than ${ORPHAN_LIMIT} sub-agent events waited for their card: one of call ${oldest} was dropped`,
        );
        if (dropped.length > 0) orphans.set(oldest, dropped);
        else orphans.delete(oldest);
    }
}

/** The held child events of a call that has just been drawn, in their order. */
function takeOrphans(parent: string): AgentEvent[] {
    expireOrphans(Date.now());
    const list = orphans.get(parent) ?? [];
    orphans.delete(parent);
    return list.map((held) => held.event);
}

/** Updates the original task card when its provider reports progress in a later automatic turn. */
export function updateHistoricalTask(
    messages: readonly Message[],
    event: TaskEvent,
): boolean {
    const id = event.tool_use_id ?? event.id;
    for (let index = messages.length - 1; index >= 0; index--) {
        const call = findCommand(messages[index].blocks, id);
        if (!call) continue;
        if (!call.background) return true;
        applyTaskEvent(call, event);
        return true;
    }
    return false;
}

export function applyAgentEvent(
    current: Block[],
    event: AgentEvent,
): ReplyUpdate {
    // The loading placeholder goes as soon as anything real arrives. Otherwise the list is changed in place: copying it
    // for every delta of a long reply, and assigning the copy back, redrew every block of the reply for each token.
    const blocks = current.some((block) => block.kind === 'loading')
        ? current.filter((block) => block.kind !== 'loading')
        : current;
    switch (event.kind) {
        case 'delta': {
            const last = blocks.at(-1);
            if (last?.kind === 'response' && last.streaming) {
                last.text += event.text;
            } else {
                close(blocks, false);
                blocks.push({
                    kind: 'response',
                    text: event.text,
                    streaming: true,
                });
            }
            return { blocks, finished: false };
        }
        case 'thinking': {
            const last = blocks.at(-1);
            if (last?.kind === 'thinking' && last.streaming) {
                last.text += event.text;
            } else {
                close(blocks, false);
                blocks.push({
                    kind: 'thinking',
                    text: event.text,
                    streaming: true,
                    startedAt: Date.now(),
                });
            }
            return { blocks, finished: false };
        }
        case 'notice':
            return { blocks, finished: false, notice: event.text };
        case 'text_end':
            // The text is done, the call it leads to is still being written: the live line goes back to "Thinking".
            close(blocks, false);
            return { blocks, finished: false };
        case 'tool_call': {
            close(blocks, false);
            const call: CommandBlock = {
                kind: 'command',
                id: event.id,
                command: `${event.name}  ${event.input}`.trim(),
                output: '',
                status: 'running',
                ...(event.background ? { background: true } : {}),
                ...(event.change
                    ? {
                          change: {
                              ...event.change,
                              create:
                                  /^(Write|write_file|writefile|create_file|createfile)$/i.test(
                                      event.name,
                                  ) && event.change.removed === 0,
                          },
                      }
                    : {}),
            };
            blocks.push(call);
            // The child events that came before this call was drawn belong under it now. Read back from the list, so the
            // change goes through the same (reactive) object the list holds.
            const drawn = blocks.at(-1);
            if (drawn?.kind === 'command')
                for (const held of takeOrphans(event.id))
                    drawn.children = applyAgentEvent(
                        drawn.children ?? [],
                        held,
                    ).blocks;
            return { blocks, finished: false };
        }
        case 'tool_result': {
            const call = blocks.find(
                (block) => block.kind === 'command' && block.id === event.id,
            );
            if (call?.kind === 'command') {
                call.output =
                    event.output.length > 6000
                        ? `${event.output.slice(0, 6000)}…`
                        : event.output;
                call.status = event.is_error ? 'fail' : 'ok';
                if (event.image) call.image = event.image;
                if (event.change && !event.is_error) {
                    const writes =
                        /^(Write|write_file|writefile|create_file|createfile)$/i.test(
                            call.command.trim().split(/\s+/, 1)[0] ?? '',
                        );
                    call.change = {
                        ...event.change,
                        create: writes && event.change.removed === 0,
                    };
                }
                // A Write over an existing file is an edit, not a creation: the tool's own message says which.
                if (call.change?.create && /updated|overwr/i.test(event.output))
                    call.change.create = false;
            }
            return { blocks, finished: false };
        }
        case 'tool_output_delta': {
            const call = blocks.find(
                (block) => block.kind === 'command' && block.id === event.id,
            );
            if (call?.kind === 'command') {
                call.output = `${call.output}${event.delta}`.slice(-6000);
            }
            return { blocks, finished: false };
        }
        case 'permission_denied':
            close(blocks, false);
            blocks.push({
                kind: 'permission',
                requests: event.requests,
                state: 'pending',
            });
            return { blocks, finished: false };
        case 'session':
            return { blocks, finished: false, agentSession: event.session_id };
        case 'done': {
            close(blocks, true);
            // Streamed text already shows the answer; the final result only fills in when nothing streamed.
            if (
                !blocks.some((block) => block.kind === 'response') &&
                event.text
            )
                blocks.push({ kind: 'response', text: event.text });
            return {
                blocks,
                finished: true,
                agentSession: event.session_id ?? undefined,
            };
        }
        case 'scoped': {
            // Child work goes under the call that started it. A child whose call is not here (yet) waits for it (see
            // holdOrphan), and is never drawn as part of the main answer.
            const parent = findCommand(blocks, event.parent);
            if (parent)
                parent.children = applyAgentEvent(
                    parent.children ?? [],
                    event.event,
                ).blocks;
            else holdOrphan(event.parent, event.event);
            return { blocks, finished: false };
        }
        case 'tool_model': {
            const call = findCommand(blocks, event.id);
            if (call) call.model = event.model;
            return { blocks, finished: false };
        }
        case 'teammate': {
            const call = findCommand(blocks, event.id);
            if (call) call.teammate = event.name;
            return { blocks, finished: false };
        }
        case 'task': {
            const call = findCommand(blocks, event.tool_use_id ?? event.id);
            // A foreground call (a Bash the CLI also reports as a task) stays an ordinary command row: only background calls get a task.
            if (call?.background) applyTaskEvent(call, event);
            return { blocks, finished: false };
        }
        case 'auto_turn':
            // Starts a reply of its own (see sessions.svelte.ts); nothing to draw in this one.
            return { blocks: current, finished: false };
        case 'usage':
            // Counted on the message, not drawn as a block (see sessions.svelte.ts).
            return { blocks: current, finished: false };
        case 'error':
            close(blocks, true, 'fail');
            // Stopping a run yourself is not a failure.
            if (event.message !== 'stopped')
                blocks.push({ kind: 'response', text: `⚠ ${event.message}` });
            return { blocks, finished: true };
        case 'raw':
            // Only for the Audit log: the chat shows nothing of it.
            return { blocks: current, finished: false };
        case 'suggestion':
            // Shown as a button under the answer, not in the reply (see events.svelte.ts).
            return { blocks: current, finished: false };
    }
}

/** Counts a `usage` event on the reply: a new model call adds its input, the output grows to the call's latest total. */
export function addUsage(
    reply: Message,
    event: Extract<AgentEvent, { kind: 'usage' }>,
) {
    reply.tokens ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const tokens = reply.tokens;
    if (event.new_call) {
        tokens.input += event.input_tokens;
        tokens.cacheRead += event.cache_read_tokens;
        tokens.cacheWrite += event.cache_write_tokens;
        reply.context =
            event.input_tokens +
            event.cache_read_tokens +
            event.cache_write_tokens;
        reply.callOutput = 0;
    }
    tokens.output += Math.max(0, event.output_tokens - (reply.callOutput ?? 0));
    reply.callOutput = event.output_tokens;
}
