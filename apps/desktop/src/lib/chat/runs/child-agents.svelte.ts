import {
    dockTool,
    isAway,
    layout,
    setToolsOpen,
} from '../../app/ui/layout.svelte';
import { chatWork } from '../session/work.svelte';
import { toChildAgent, type ChildAgent } from './child-agents';

/** The side view's tool name: the Sub agents panel in the tools panel, or in a window. */
export const AGENTS_TOOL = 'Agents';
/** How many agents the grid shows at once. */
export const GRID_MAX = 4;

export type AgentViewMode = 'list' | 'single' | 'grid';

/** What the Sub agents panel shows. Kept in memory: the panel starts on the list. */
export const agentView = $state({
    mode: 'list' as AgentViewMode,
    /** The agent the single view shows. */
    selected: null as string | null,
    /** The agents the grid shows, in the order they were added. */
    picked: [] as string[],
});

/** The sub agents and background jobs a chat started, live: re-reads whenever the work tray changes. */
export function childAgents(parentId: string): ChildAgent[] {
    return chatWork(parentId)
        .map(toChildAgent)
        .filter((agent): agent is ChildAgent => agent !== null);
}

/** Opens one agent in the side view, beside the chat. */
export function openAgentView(id: string) {
    agentView.mode = 'single';
    agentView.selected = id;
    dockTool(AGENTS_TOOL);
}

/** Adds the agent to the grid, or takes it out. The grid holds at most `GRID_MAX` agents. */
export function toggleGridAgent(id: string) {
    if (agentView.picked.includes(id)) {
        agentView.picked = agentView.picked.filter((item) => item !== id);
    } else if (agentView.picked.length < GRID_MAX) {
        agentView.picked = [...agentView.picked, id];
    }
}

/** The toolbar button: shows the panel, or closes it when it is already open in the tools panel. */
export function toggleAgentsPanel() {
    const open =
        layout.toolsOpen &&
        layout.activeTool === AGENTS_TOOL &&
        !isAway(AGENTS_TOOL);
    if (open) setToolsOpen(false);
    else dockTool(AGENTS_TOOL);
}
