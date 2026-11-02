import { SvelteMap } from 'svelte/reactivity';
// What the user opened in the step lists of a chat (the line "Ran 2 commands, looked at 3 things" and its steps).
// A list is rebuilt when its chat comes back on screen (another chat, the parent and back, a reload of the view), so
// what is open is kept here, by chat, message and position, and not in the list itself. Not saved to disk.
//
// Reading and writing are separate on purpose: `states` is reactive, and Svelte forbids writing reactive state while a
// `$derived` or a template is evaluated (`state_unsafe_mutation`, the row then shows "This message could not be
// drawn"). A list reads with `groupView` while it renders and creates its entry with `editGroup` only when the user
// opens something.

export type GroupState = {
    open: boolean;
    thinking: boolean;
    rows: Record<number, boolean>;
};

const states = new SvelteMap<string, GroupState>();

/** Nothing opened yet. Shared and frozen: never written to. */
const CLOSED: GroupState = Object.freeze({
    open: false,
    thinking: false,
    rows: Object.freeze({}) as Record<number, boolean>,
});

/** What is open in one list. Read only: safe in `$derived` and templates. */
export function groupView(key: string): GroupState {
    return states.get(key) ?? CLOSED;
}

/** The list's own entry, created on first use. Writes state: call it only from event handlers. */
export function editGroup(key: string): GroupState {
    const found = states.get(key);
    if (found) return found;
    // `$state` must initialise a declaration (state_invalid_placement), so the new entry gets its own const.
    const fresh: GroupState = $state({
        open: false,
        thinking: false,
        rows: {},
    });
    states.set(key, fresh);
    return fresh;
}
