import type { ChatWork } from './chat-work.ts';
import type { Block, Message } from '../mock.ts';

/** Where a child agent's transcript lives: its own chat (delegate, fork) or the tool call that started it in the parent. */
export type ChildAgentSource =
    | { type: 'session'; sessionId: string }
    | { type: 'call'; messageId: string; callId: string };

/** A sub agent or background job of one chat, shaped for a side view that shows its live transcript. */
export type ChildAgent = {
    id: string;
    parentId: string;
    title: string;
    state: ChatWork['state'];
    kind: ChatWork['kind'];
    agent?: string;
    model?: string | null;
    startedAt: number;
    endedAt?: number;
    canStop: boolean;
    source: ChildAgentSource;
    /** The tray's work row behind it: Stop goes through it (`stopWork`). */
    work: ChatWork;
};

/** Maps background work to child agents. Work with no transcript to show is dropped. */
export function toChildAgent(work: ChatWork): ChildAgent | null {
    if (work.kind !== 'agent') return null;
    const source: ChildAgentSource | null = work.childId
        ? { type: 'session', sessionId: work.childId }
        : work.sourceMessageId && work.callId
          ? {
                type: 'call',
                messageId: work.sourceMessageId,
                callId: work.callId,
            }
          : null;
    if (!source) return null;
    return {
        id: work.id,
        parentId: work.sessionId,
        title: work.title,
        state: work.state,
        kind: work.kind,
        agent: work.agent,
        model: work.model,
        startedAt: work.startedAt,
        endedAt: work.endedAt,
        canStop: Boolean(work.canStop),
        source,
        work,
    };
}

/** The steps a sub agent's tool call holds in the parent chat, found by the call's id. `messageId` is the request the
 *  call answers (a user message), not the reply that holds the call, so it only orders the search: the reply is found
 *  by the call's id, which is unique to the run. */
export function callChildBlocks(
    messages: readonly Pick<Message, 'id' | 'blocks'>[],
    messageId: string,
    callId: string,
    kind: ChatWork['kind'] = 'agent',
): Block[] {
    const isCall = (
        block: Block,
    ): block is Extract<Block, { kind: 'command' }> =>
        block.kind === 'command' && block.id === callId;
    const own = messages.find((item) => item.id === messageId);
    const call =
        own?.blocks.find(isCall) ??
        messages.flatMap((item) => item.blocks).find(isCall);
    // A background command has no steps of its own: its transcript is the command row, output included, as in the chat.
    if (call && kind === 'command') return [call];
    const children = call?.children ?? [];
    // The sub agent's report comes back as the call's result, not as a step under it: it closes the transcript. A chat
    // read back from the CLI's history has this result even when it has no steps.
    const report = call && call.status !== 'running' ? call.output.trim() : '';
    const written = children.some(
        (block) => block.kind === 'response' && block.text.trim() === report,
    );
    return report && !written
        ? [...children, { kind: 'response', text: report }]
        : children;
}
