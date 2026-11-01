import type { Block, FileChange, Message } from '../mock';

export type ActivityStatus = 'completed' | 'failed' | 'stopped';

export type ActivityChange = Pick<FileChange, 'path' | 'added' | 'removed' | 'create' | 'cumulative'> & {
  deleted?: boolean;
};

export type ActivityEntryInput = {
  id: string;
  at: string;
  project: string;
  projectPath: string;
  sessionId: string;
  chatTitle: string;
  agent: string;
  model?: string | null;
  status: ActivityStatus;
  request: string;
  summary: string;
  changes: ActivityChange[];
  note?: string;
};

export type ActivityEntry = ActivityEntryInput & {
  markdown: string;
  title: string;
};

const MARKER = '<!-- agentdeck:activity-entry ';
const ENTRY_RE = /<!-- agentdeck:activity-entry ([^\n]+) -->[\t ]*\n?([\s\S]*?)(?=\n<!-- agentdeck:activity-entry |\s*$)/g;
const CHANGE_RE = /^- `(.+?)` — \+(\d+) \/ −(\d+)(?: · (created|deleted))?$/gm;

const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim();
const inline = (text: string) => oneLine(text).replaceAll('|', '\\|');
const quote = (text: string) => {
  const value = text.trim();
  return value ? value.split(/\r?\n/).map((line) => `> ${line || '>'}`).join('\n') : '> _(empty)_';
};

function entryMeta(entry: ActivityEntryInput) {
  return JSON.stringify({
    id: entry.id,
    at: entry.at,
    project: entry.project,
    projectPath: entry.projectPath,
    sessionId: entry.sessionId,
    title: entry.chatTitle,
    agent: entry.agent,
    model: entry.model ?? null,
    status: entry.status,
  });
}

function statusLabel(status: ActivityStatus) {
  return status === 'completed' ? 'Completed' : status === 'failed' ? 'Failed' : 'Stopped';
}

function formatChange(change: ActivityChange) {
  const kind = change.deleted ? 'deleted' : change.create ? 'created' : undefined;
  return `- \`${change.path.replaceAll('`', '\\`')}\` — +${change.added} / −${change.removed}${kind ? ` · ${kind}` : ''}`;
}

/** Renders one append-only, commit-like Markdown section. */
export function activityEntryMarkdown(entry: ActivityEntryInput): string {
  const changes = entry.changes.length ? entry.changes.map(formatChange).join('\n') : '- No file changes were reported.';
  const duration = entry.note?.match(/\bafter\s+(.+?)(?:\.|$)/i)?.[1];
  return [
    `${MARKER}${entryMeta(entry)} -->`,
    `## ${inline(entry.chatTitle)} · ${entry.at}`,
    '',
    `- **Project:** ${inline(entry.project || 'This computer')}`,
    `- **Agent:** ${inline(entry.agent)}${entry.model ? ` · ${inline(entry.model)}` : ''}`,
    `- **Status:** ${statusLabel(entry.status)}${duration ? ` · ${inline(duration)}` : ''}`,
    `- **Session:** \`${entry.sessionId}\``,
    '',
    '### Request',
    '',
    quote(entry.request),
    '',
    '### Changes',
    '',
    changes,
    '',
    '### Summary',
    '',
    entry.summary.trim() || '_No summary was returned._',
    '',
  ].join('\n');
}

/** Parses the append-only Markdown log while tolerating a missing or old header. */
export function parseActivityLog(text: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const match of text.matchAll(ENTRY_RE)) {
    let meta: Partial<ActivityEntryInput> & { title?: string };
    try {
      meta = JSON.parse(match[1]) as Partial<ActivityEntryInput> & { title?: string };
    } catch {
      continue;
    }
    if (!meta.id || !meta.at || !meta.title || !meta.status) continue;
    const markdown = `${MARKER}${match[1]} -->\n${match[2].trim()}`;
    const changes = [...match[2].matchAll(CHANGE_RE)].map((change) => ({
      path: change[1],
      added: Number(change[2]),
      removed: Number(change[3]),
      create: change[4] === 'created',
      ...(change[4] === 'deleted' ? { deleted: true } : {}),
    }));
    const request = match[2].match(/### Request\s+([\s\S]*?)(?=\n### |$)/)?.[1]
      ?.split(/\r?\n/)
      .map((line) => line.replace(/^> ?/, ''))
      .join('\n')
      .trim() ?? '';
    const summary = match[2].match(/### Summary\s+([\s\S]*?)(?=\n### |$)/)?.[1]?.trim() ?? '';
    entries.push({
      id: meta.id,
      at: meta.at,
      project: meta.project ?? '',
      projectPath: meta.projectPath ?? '',
      sessionId: meta.sessionId ?? '',
      chatTitle: meta.title,
      title: meta.title,
      agent: meta.agent ?? '',
      model: meta.model,
      status: meta.status,
      request,
      summary,
      changes,
      markdown,
    });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

function collectChanges(blocks: Block[], into: ActivityChange[]) {
  for (const block of blocks) {
    if (block.kind !== 'command') continue;
    if (block.change) into.push({ ...block.change });
    if (block.children) collectChanges(block.children, into);
  }
}

/** Collects file changes once per path, replacing cumulative snapshots and summing tool-level deltas. */
export function changesFromMessages(messages: Message[]): ActivityChange[] {
  const byPath = new Map<string, ActivityChange>();
  for (const message of messages) {
    const changes: ActivityChange[] = [];
    collectChanges(message.blocks, changes);
    for (const change of changes) {
      const current = byPath.get(change.path);
      byPath.set(change.path, change.cumulative === false
        ? {
            path: change.path,
            added: (current?.added ?? 0) + change.added,
            removed: (current?.removed ?? 0) + change.removed,
            cumulative: false,
            create: current?.create || change.create,
            deleted: current?.deleted || false,
          }
        : {
            path: change.path,
            added: change.added,
            removed: change.removed,
            cumulative: true,
            create: current?.create || change.create,
            deleted: current?.deleted || false,
          });
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function messageText(message: Message | undefined): string {
  return message?.blocks
    .flatMap((block) => block.kind === 'response' ? [block.text] : [])
    .join('\n')
    .trim() ?? '';
}
