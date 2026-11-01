import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityEntryMarkdown,
  parseActivityLog,
  type ActivityEntryInput,
} from './project-activity.ts';

const entry: ActivityEntryInput = {
  id: 's1-m2',
  at: '2026-11-01T10:20:30.000Z',
  project: 'agentdeck',
  projectPath: 'E:\\WORK\\PROJECTS\\agentdeck',
  sessionId: 's1',
  chatTitle: 'Activity log',
  agent: 'codex',
  model: 'gpt-5.6-luna',
  status: 'completed',
  request: 'Add a persistent project activity log.',
  summary: 'Added the Markdown activity log and connected it to completed turns.',
  changes: [
    { path: 'src/lib/chat/runs/project-activity.ts', added: 72, removed: 0, create: true },
    { path: 'src/lib/components/tasks/TasksView.svelte', added: 8, removed: 2, create: false },
  ],
};

test('activity entries round trip as grouped Markdown sections', () => {
  const markdown = `# AgentDeck project activity\n\n${activityEntryMarkdown(entry)}`;
  const parsed = parseActivityLog(markdown);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, entry.id);
  assert.equal(parsed[0].title, entry.chatTitle);
  assert.equal(parsed[0].status, entry.status);
  assert.equal(parsed[0].at, entry.at);
  assert.deepEqual(parsed[0].changes, entry.changes);
  assert.match(parsed[0].markdown, /### Summary/);
  assert.match(parsed[0].markdown, /persistent project activity log/);
});

test('activity entries escape Markdown control characters in metadata', () => {
  const markdown = activityEntryMarkdown({
    ...entry,
    id: 's1-unsafe',
    chatTitle: 'Fix | pipes',
    request: 'Use `code` and | table markers',
  });
  const parsed = parseActivityLog(markdown);

  assert.equal(parsed[0].title, 'Fix | pipes');
  assert.match(parsed[0].markdown, /Fix \\| pipes/);
  assert.match(parsed[0].markdown, /Use `code` and \\| table markers/);
});
