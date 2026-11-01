/** Execution lanes sharing one visible chat transcript. */
export type RunLane = {
  id: string;
  role: 'primary' | 'listener';
  state: 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
  /** The provider explicitly reported child/background work that can outlive the current assistant step. */
  backgroundWork: boolean;
};

export type MessageDelivery = 'send' | 'queue' | 'listener';

/** Shell-like tools whose command can keep a turn occupied while work continues elsewhere. */
const SHELL_TOOL = /(?:^|[._/:]|__)(?:bash|shell|exec|exec_command|powershell|pwsh|cmd|run_in_terminal|run_shell_command|run_command|terminal|command|read_bash|write_bash|read_powershell|write_powershell)$/i;
const SERVE_TOOL = /(?:^|[._/:]|__)browser_serve$/i;
const LONG_RUNNING_WORD = /\b(?:build|bundle|check|clippy|compile|deploy|dev|download|export|fetch|import|install|migrate|package|pull|push|release|run|seed|serve|start|sync|test|timeout|update|upgrade|wait|watch|sleep)\b/i;
const TRANSFER_COMMAND = /(?:^|[;&|]\s*)(?:curl|wget|Invoke-WebRequest|Start-BitsTransfer|gh\s+run\s+(?:watch|view))\b/i;

/** Read the command text from the JSON used by Bash/Shell tools, with plain text as a safe fallback. */
function commandText(input: string): string {
  try {
    const value = JSON.parse(input) as Record<string, unknown>;
    return [value.command, value.cmd, value.script, Array.isArray(value.args) ? value.args.join(' ') : '']
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
  } catch {
    return input;
  }
}

/** Detect work that should release the chat while its provider call is still running. */
export function isLongRunningWork(name: string, input = ''): boolean {
  if (SERVE_TOOL.test(name)) return true;
  const command = commandText(input);
  return SHELL_TOOL.test(name) && (LONG_RUNNING_WORD.test(command) || TRANSFER_COMMAND.test(command));
}

/** Codex's wait call repeats the task count already presented by provider-native Agent activity cards. */
export function isRedundantAgentWait(command: string, hasAgentTasks: boolean): boolean {
  return hasAgentTasks && /^wait\s+\d+\s+agent\(s\)/i.test(command.trimStart());
}

/** Choose the route for a new message without treating ordinary tool execution as an idle wait. */
export function deliveryFor(lanes: readonly RunLane[]): MessageDelivery {
  const active = lanes.filter((lane) => lane.state === 'running' || lane.state === 'waiting');
  if (active.length === 0) return 'send';

  const listenerActive = active.some((lane) => lane.role === 'listener');
  const hasBackgroundWait = active.some(
    (lane) => lane.role === 'primary' && lane.state === 'waiting' && lane.backgroundWork,
  );
  if (hasBackgroundWait && !listenerActive) return 'listener';
  return 'queue';
}

/** Only an explicit provider wait releases a foreground slot; spawning a child alone does not mean the lead is idle. */
export function isBackgroundWait(name: string, background = false, input = ''): boolean {
  if (background && /^(?:delegate_task|mcp__agentdeck__delegate_task|agentdeck[.:/_]delegate_task)$/i.test(name)) {
    try {
      const wait = JSON.parse(input).wait;
      if (wait === false || wait === 0 || (typeof wait === 'string' && /^(false|no|0)$/i.test(wait.trim()))) return false;
    } catch { /* Provider summaries can be truncated; background is authoritative. */ }
    return true;
  }
  return /(?:^|[._/])(?:wait|wait_agent|wait_agents|wait_task|wait_for_completion)$/i.test(name);
}
