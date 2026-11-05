import { untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { getPref, setPref } from '../../app/platform/prefs';
import {
    activity,
    stopBackgroundCommand,
    stopProjectRun,
} from '../runs/activity.svelte';
import { backgroundStoppedNotice } from '../runs/notices';
import { notifyRun } from '../runs/notices.svelte';
import { toast } from '../../app/platform/toast';
import {
    isWorkActive,
    projectChatWork,
    stopTarget,
    type ChatWork,
} from '../runs/chat-work';
import { delegateTasks, stopDelegateTask } from './delegate-task.svelte';
import { delegateRuns } from './delegation.svelte';
import { manuallyStopped } from './events.svelte';
import { stopTurn } from './turns.svelte';

const KEY = 'chat.background-work.v1';
const restored = $state<ChatWork[]>([]);
let ready = $state(false);
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingSnapshot: ChatWork[] = [];
void getPref<ChatWork[]>(KEY)
    .then((saved) => {
        if (!Array.isArray(saved)) return;
        for (const item of saved) {
            if (
                !item ||
                typeof item.id !== 'string' ||
                typeof item.sessionId !== 'string' ||
                typeof item.title !== 'string'
            )
                continue;
            restored.push(
                isWorkActive(item)
                    ? {
                          ...item,
                          state: 'unknown',
                          canStop: false,
                          endedAt: Date.now(),
                          detail: `Last seen active before reload. Open the worker or inspect its output to confirm status.\n\n${item.detail}`,
                      }
                    : item,
            );
        }
    })
    .catch(() => {})
    .finally(() => {
        ready = true;
    });

/** Stop ends what the work runs: an AgentDeck-owned project server, a worker task, or a child chat's turn. */
export function stopWork(item: ChatWork) {
    switch (stopTarget(item)) {
        case 'project':
            void stopProjectRun(item.activityKey!);
            break;
        case 'delegate':
            stopDelegateTask(item.delegateId!);
            break;
        case 'child':
            stopTurn(item.childId!);
            break;
        case 'native':
            void stopNative(item);
            break;
    }
}

/** Ends a background command alone and tells the chat's model, which keeps working. */
async function stopNative(item: ChatWork) {
    const command = item.command!;
    if (!(await stopBackgroundCommand(item.activityKey!, command))) {
        toast.error(
            'Could not stop that background command: its process was not found.',
        );
        return;
    }
    await notifyRun(
        item.sessionId,
        backgroundStoppedNotice(command),
        'background-stop',
    );
}

/** Work survives transcript eviction and chat switching; restored work never claims to be live without fresh events. */
export function chatWork(sessionId?: string): ChatWork[] {
    const current = projectChatWork(
        activity,
        Object.values(delegateTasks),
        delegateRuns,
    ).map((item) => {
        if (!item.delegateId && item.childId && manuallyStopped[item.childId])
            return {
                ...item,
                state: 'paused' as const,
                canPause: false,
                canResume: true,
            };
        return item;
    });
    const ids = new SvelteSet(current.map((item) => item.id));
    const all = [...current, ...restored.filter((item) => !ids.has(item.id))];
    return sessionId === undefined
        ? all
        : all.filter((item) => item.sessionId === sessionId);
}

/** The parts of the work a snapshot keeps that change rarely: a call's status, label or end, a worker's and a run's
 *  state. Streamed output is left out, so the tray is not projected again for each line a worker prints. */
function structureKey(): string {
    const parts: string[] = [];
    for (const item of activity)
        parts.push(
            [
                item.key,
                item.status,
                item.taskLabel ?? '',
                item.endedAt ?? '',
                item.title,
                item.input,
                item.name,
            ].join('\u0001'),
        );
    for (const task of Object.values(delegateTasks))
        parts.push(
            [
                task.id,
                task.state,
                task.reportState ?? '',
                task.pausedAt ?? '',
                task.replacementChildId ?? '',
            ].join('\u0001'),
        );
    for (const run of delegateRuns)
        parts.push(
            [
                run.id,
                run.handback,
                run.endedAt ?? '',
                run.cancelled ? 'cancelled' : '',
                ...run.nodes.map(
                    (node) => `${node.childId}\u0001${node.state}`,
                ),
            ].join('\u0002'),
        );
    return parts.join('\n');
}
let lastKey = '';

$effect.root(() => {
    $effect(() => {
        if (!ready) return;
        const key = structureKey();
        if (key === lastKey) return;
        lastKey = key;
        const all = untrack(() => chatWork());
        const active = all.filter(isWorkActive);
        const recent = all
            .filter((item) => !isWorkActive(item))
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, 100);
        pendingSnapshot = JSON.parse(
            JSON.stringify([...active, ...recent]),
        ) as ChatWork[];
        // Throttle instead of debounce: a continuously streaming worker still gets periodic recovery snapshots.
        saveTimer ??= setTimeout(() => {
            saveTimer = undefined;
            setPref(KEY, pendingSnapshot);
        }, 300);
    });
});
