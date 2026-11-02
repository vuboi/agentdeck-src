import { SvelteDate, SvelteSet } from 'svelte/reactivity';
import type { Message } from '../mock';
import { inTauri, isPreviewCopy } from '../../app/platform/history';
import {
    activityEntryMarkdown,
    changesFromMessages,
    messageText,
    parseActivityLog,
    type ActivityEntry,
    type ActivityStatus,
} from './project-activity';

export const projectActivityCache = $state<Record<string, string>>({});
const loaded = new SvelteSet<string>();
const loading = new SvelteSet<string>();

async function invoke<T>(command: string, args: Record<string, unknown>) {
    const { invoke: call } = await import('@tauri-apps/api/core');
    return call<T>(command, args);
}

export function activityEntries(root: string): ActivityEntry[] {
    return parseActivityLog(projectActivityCache[root] ?? '');
}

export async function loadProjectActivity(root: string): Promise<void> {
    if (
        !root ||
        !inTauri() ||
        isPreviewCopy() ||
        loaded.has(root) ||
        loading.has(root)
    )
        return;
    loading.add(root);
    try {
        projectActivityCache[root] = await invoke<string>(
            'project_activity_read',
            { root },
        );
        loaded.add(root);
    } catch {
        // The pane can still show the other projects when one folder is unavailable.
    } finally {
        loading.delete(root);
    }
}

export type RecordProjectActivityArgs = {
    root: string;
    project: string;
    sessionId: string;
    chatTitle: string;
    agent: string;
    model?: string | null;
    status: ActivityStatus;
    request?: Message;
    reply: Message;
    note?: string;
};

/** Appends one completed visible turn to the project's shared Markdown log. */
export async function recordProjectActivity(
    args: RecordProjectActivityArgs,
): Promise<void> {
    if (!args.root || !inTauri() || isPreviewCopy()) return;
    const entry = activityEntryMarkdown({
        id: `${args.sessionId}-${args.reply.id}`,
        at: args.reply.at ?? new SvelteDate().toISOString(),
        project: args.project,
        projectPath: args.root,
        sessionId: args.sessionId,
        chatTitle: args.chatTitle,
        agent: args.agent,
        model: args.model,
        status: args.status,
        request:
            messageText(args.request) ||
            args.reply.taskTitle ||
            'Background work',
        summary: messageText(args.reply),
        changes: changesFromMessages([args.reply]),
        note: args.note,
    });
    try {
        await invoke('project_activity_append', { root: args.root, entry });
        projectActivityCache[args.root] =
            `${projectActivityCache[args.root]?.trimEnd() ?? '# AgentDeck project activity'}\n\n${entry}\n`;
        loaded.add(args.root);
    } catch {
        // Activity logging must never hold up delivery of a reply.
    }
}
