import { inTauri } from '../app/platform/history';

// Which agent CLIs are installed here and which are signed in (Rust: `agents_status`, src-tauri/src/agents.rs).
// Until the first answer nothing is hidden.

export type AgentStatus = {
    id: string;
    installed: boolean;
    configured: boolean;
};

export const agentStatus = $state({ list: null as AgentStatus[] | null });

export async function loadAgentStatus(): Promise<void> {
    if (!inTauri()) return;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        agentStatus.list = await invoke<AgentStatus[]>('agents_status');
    } catch {
        // Keep the last answer; a failed check must not hide providers.
    }
}

/** False only for a CLI that is known not to be installed. */
export function isInstalled(id: string): boolean {
    return agentStatus.list?.find((row) => row.id === id)?.installed ?? true;
}

/** False only for a CLI that is known to be installed-or-not and not signed in. Used by the model picker. */
export function isConfigured(id: string): boolean {
    return agentStatus.list?.find((row) => row.id === id)?.configured ?? true;
}
