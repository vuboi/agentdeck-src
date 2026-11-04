import type { ZLoadingSpinner } from '@shival99/z-ui-svelte';
import { LOADER } from '../../app/platform/loaders';
import { backgroundTaskName, liveState, waitingLabel } from '../content/blocks';
import { activity } from './activity.svelte';
import { workspace } from '../sessions.svelte';
import { sessionLanes } from '../session/run.svelte';
import { agentDisplayName } from '../../agents/provider-registry';
import { modelLabel } from '../../agents/models.svelte';
import type { Message } from '../mock';

export type LiveLine = { label: string; spinner: ZLoadingSpinner };

/** What a running reply is doing now ("Thinking", "Running pnpm test", "Waiting for approval"), for its one live line.
 *  Reads the activity log, so call it inside a $derived. */
export function liveLine(message: Message): LiveLine {
    // Before the first event a task another agent handed over, or pictures read ahead, say who they went to. A message
    // the user sent to the main agent shows its normal state ("Thinking") like any other turn.
    if (
        message.dispatching &&
        (message.handedOff || Boolean(message.dispatchingImages))
    ) {
        if (message.dispatchingImages) {
            const { count, reader } = message.dispatchingImages;
            return {
                label: `Waiting to extract info from ${count === 1 ? 'image' : 'images'} by ${reader}`,
                spinner: LOADER.thinking,
            };
        }
        const who = message.agent
            ? [
                  agentDisplayName(message.agent, message.model),
                  modelLabel(message.model) || message.model,
              ]
                  .filter(Boolean)
                  .join(' · ')
            : 'agent';
        return { label: `Sending task to ${who}`, spinner: LOADER.thinking };
    }
    // The CLI compacts its context: the model is blocked until it is done, so nothing else runs meanwhile.
    if (message.compacting)
        return { label: 'Compressing context', spinner: LOADER.thinking };
    // The provider is retrying its request: the live line says so, the reasoning above is left alone.
    if (message.notice)
        return { label: message.notice, spinner: LOADER.thinking };
    // The provider's background tasks still running in this chat (a sub agent, a shell): while the reply only waits for
    // them, the line says so instead of "Thinking".
    const open = activity
        .filter(
            (item) =>
                item.sessionId === workspace.activeId &&
                item.background &&
                (item.status === 'running' || item.status === 'background'),
        )
        .map((item) => ({ name: backgroundTaskName(item) }));
    const waiting = waitingLabel(message.blocks, open);
    if (waiting !== null) return { label: waiting, spinner: LOADER.background };
    const state = liveState(message.blocks);
    // The main run waits while a side run works for the user (plan 6.6): it says so, rather than "Thinking".
    if (state.label === 'Thinking' && sideRunWorking(workspace.activeId))
        return { label: 'Waiting for progress', spinner: LOADER.background };
    return state;
}

/** A side run (listener) of the chat works while its main run waits for the turn to end. */
function sideRunWorking(sessionId: string): boolean {
    const lanes = sessionLanes[sessionId] ?? [];
    const active = (state: string) =>
        state === 'running' || state === 'waiting';
    return (
        lanes.some(
            (lane) => lane.role === 'primary' && lane.state === 'waiting',
        ) &&
        lanes.some((lane) => lane.role === 'listener' && active(lane.state))
    );
}

/** The text being written is its own progress: no label is shown over it. */
export const isWriting = (line: LiveLine) => line.label === 'Writing reply';
