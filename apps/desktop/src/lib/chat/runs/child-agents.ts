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

/** The steps a sub agent's tool call holds in the parent chat, found by the call's id. */
export function callChildBlocks(
    messages: readonly Pick<Message, 'id' | 'blocks'>[],
    messageId: string,
    callId: string,
): Block[] {
    const message = messages.find((item) => item.id === messageId);
    const call = message?.blocks.find(
        (block): block is Extract<Block, { kind: 'command' }> =>
            block.kind === 'command' && block.id === callId,
    );
    return call?.children ?? [];
}
