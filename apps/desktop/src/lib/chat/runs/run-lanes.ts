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
const SHELL_TOOL =
    /(?:^|[._/:]|__)(?:bash|shell|exec|exec_command|powershell|pwsh|cmd|run_in_terminal|run_shell_command|run_command|terminal|command|read_bash|write_bash|read_powershell|write_powershell)$/i;
const SERVE_TOOL = /(?:^|[._/:]|__)browser_serve$/i;
/** A shell command that is still running after this long, while its reply waits for it, is background work: the chat is
 *  released then. Judged by time, not by the command's name: `git diff --check` and lint are short, and handing the chat to
 *  a listener while they run split one answer in two. */
export const SHELL_WAIT_MS = 20_000;

export function isShellCall(name: string): boolean {
    return SHELL_TOOL.test(name);
}

/** A dev server runs on by its nature, so it releases the chat at once. Shell commands are judged by time (SHELL_WAIT_MS). */
export function isLongRunningWork(name: string): boolean {
    return SERVE_TOOL.test(name);
}

/** Codex's wait call repeats the task count already presented by provider-native Agent activity cards. */
export function isRedundantAgentWait(
    command: string,
    hasAgentTasks: boolean,
): boolean {
    return (
        hasAgentTasks && /^wait\s+\d+\s+agent\(s\)/i.test(command.trimStart())
    );
}

/** Choose the route for a new message without treating ordinary tool execution as an idle wait. */
export function deliveryFor(lanes: readonly RunLane[]): MessageDelivery {
    const active = lanes.filter(
        (lane) => lane.state === 'running' || lane.state === 'waiting',
    );
    if (active.length === 0) return 'send';

    const listenerActive = active.some((lane) => lane.role === 'listener');
    const hasBackgroundWait = active.some(
        (lane) =>
            lane.role === 'primary' &&
            lane.state === 'waiting' &&
            lane.backgroundWork,
    );
    if (hasBackgroundWait && !listenerActive) return 'listener';
    return 'queue';
}

/** Only an explicit provider wait releases a foreground slot; spawning a child alone does not mean the lead is idle. */
export function isBackgroundWait(
    name: string,
    background = false,
    input = '',
): boolean {
    if (
        background &&
        /^(?:delegate_task|mcp__agentdeck__delegate_task|agentdeck[.:/_]delegate_task)$/i.test(
            name,
        )
    ) {
        try {
            const wait = JSON.parse(input).wait;
            if (
                wait === false ||
                wait === 0 ||
                (typeof wait === 'string' &&
                    /^(false|no|0)$/i.test(wait.trim()))
            )
                return false;
        } catch {
            /* Provider summaries can be truncated; background is authoritative. */
        }
        return true;
    }
    return /(?:^|[._/])(?:wait|wait_agent|wait_agents|wait_task|wait_for_completion)$/i.test(
        name,
    );
}
