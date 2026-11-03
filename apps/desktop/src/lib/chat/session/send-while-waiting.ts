// A message sent while a chat only waits for background work of its own (a Claude sub-agent or job it started). Such a
// chat has no answer in progress: the CLI keeps reading its process and takes a message between two answers (see
// `tail::deliver` in the adapters). Everything else queues the message as before.

export type WaitState = {
    agent: string | undefined;
    /** How the message is sent when a turn runs ('queue' is the default; Ctrl/Cmd+Enter and Alt+Enter keep their own rules). */
    whileRunning: 'queue' | 'next' | 'interrupt';
    /** A reply of the user's own turn is live (not one the CLI started on its own). */
    foregroundTurn: boolean;
    /** The live reply is writing text right now. */
    streamingText: boolean;
    /** The chat has background work of its own that has not ended. */
    backgroundWorkOpen: boolean;
    /** Questions or a permission request wait for an answer. */
    needsUserInput: boolean;
};

/** True when the message may go straight to the CLI instead of the chat's queue. */
export function canSendWhileWaiting(state: WaitState): boolean {
    return (
        state.agent === 'claude' &&
        state.whileRunning === 'queue' &&
        state.backgroundWorkOpen &&
        !state.foregroundTurn &&
        !state.streamingText &&
        !state.needsUserInput
    );
}

/** Background work of a chat that has not ended (a stopped one is not waited for). */
export function hasOpenBackgroundWork(
    items: ReadonlyArray<{
        sessionId: string;
        background: boolean;
        endedAt?: number;
        status: string;
    }>,
    sessionId: string,
): boolean {
    return items.some(
        (item) =>
            item.sessionId === sessionId &&
            item.background &&
            item.endedAt === undefined &&
            item.status !== 'stopped',
    );
}
