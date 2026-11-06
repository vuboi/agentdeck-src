// The three choices on a propose_session card (ProposalCard.svelte). The choice is kept in the call's block of the message
// (`proposal`), so it stays with the reply. Nothing runs until the user picks one.
import { persistLocal, workspace } from './state.svelte';
import { send } from './sending.svelte';
import { startProposalWorker } from './delegate-task.svelte';
import type { CommandBlock } from '../content/blocks';
import {
    proposalOfCommand,
    startOrderOf,
    workerCallsOf,
} from '../../tasks/propose';

/** Split: one worker per task, each in its own worktree and started in the background (the same path as delegate_task). */
export function splitProposal(sessionId: string, item: CommandBlock): void {
    const parsed = proposalOfCommand(item.command);
    const session = workspace.sessions.find((chat) => chat.id === sessionId);
    if (!parsed.ok || !session || item.proposal) return;
    item.proposal = { state: 'split' };
    const calls = workerCallsOf(parsed.proposal, {
        agent: session.agent,
        model: session.model,
    });
    // Each task starts after the tasks it depends on: its depends_on is their task ids, known once they started.
    const started = new Map<string, Promise<string | undefined>>();
    for (const at of startOrderOf(parsed.proposal)) {
        const task = parsed.proposal.tasks[at];
        const waits = task.dependsOn.map(
            (name) => started.get(name) ?? Promise.resolve(undefined),
        );
        started.set(
            task.title,
            Promise.all(waits).then((ids) => {
                if (ids.some((id) => !id)) {
                    noteOn(
                        item,
                        `${task.title} did not start: a task it depends on did not start.`,
                    );
                    return undefined;
                }
                return startProposalWorker(
                    sessionId,
                    calls[at],
                    (text, isError) => {
                        // A worker that did not start says why on the card: the choice stays made, the note shows the reason.
                        if (isError) noteOn(item, text);
                    },
                    ids as string[],
                );
            }),
        );
    }
    persistLocal();
}

/** Do it in this chat: the chat's agent is asked to go ahead here, in one turn. */
export function chatProposal(sessionId: string, item: CommandBlock): void {
    if (item.proposal) return;
    item.proposal = { state: 'chat' };
    persistLocal();
    send(sessionId, 'Go ahead in this chat.', [], []);
}

export function dismissProposal(item: CommandBlock): void {
    if (item.proposal) return;
    item.proposal = { state: 'dismissed' };
    persistLocal();
}

function noteOn(item: CommandBlock, text: string) {
    const note = [item.proposal?.note, text].filter(Boolean).join(' ');
    item.proposal = { state: item.proposal?.state ?? 'split', note };
    persistLocal();
}
