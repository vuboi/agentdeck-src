// Notices between runs: queued per chat until its next prompt, or handed to the running turn when the provider reads
// its inbox between steps (agent_notify). Plan: plan.md 6.2.
import { logFlow } from '../../tasks/flow-log';
import { noticeBlock } from './notices';

export const pendingNotices = $state<Record<string, string[]>>({});

export function queueNotice(sessionId: string, text: string): void {
    (pendingNotices[sessionId] ??= []).push(text);
}

/** The chat's queued notices as one block for its next prompt, and forgets them. Empty when there are none. */
export function takeNoticeBlock(sessionId: string): string {
    const list = pendingNotices[sessionId];
    if (!list?.length) return '';
    delete pendingNotices[sessionId];
    return noticeBlock(list);
}

/** Tries to hand a notice to the running turn of the chat; keeps it for the next turn when that is not possible. */
export async function notifyRun(
    sessionId: string,
    text: string,
    reason: string,
): Promise<'steered' | 'queued'> {
    const steered = await import('@tauri-apps/api/core')
        .then(({ invoke }) =>
            invoke<boolean>('agent_notify', { session: sessionId, text }),
        )
        .catch(() => false);
    if (!steered) queueNotice(sessionId, text);
    logFlow(
        sessionId,
        'notify',
        `via=${steered ? 'steer' : 'queued'} reason=${reason} chars=${text.length}`,
    );
    return steered ? 'steered' : 'queued';
}
