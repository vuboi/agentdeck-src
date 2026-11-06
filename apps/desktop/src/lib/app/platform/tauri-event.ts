// `listen` of Tauri's events, except in the Preview's own copy of the app: the events are sent to every webview, and the
// copy answering them as well would do everything twice (saving, replying to the agents). It gets none.

import type {
    EventCallback,
    EventName,
    Options,
    UnlistenFn,
} from '@tauri-apps/api/event';
import { isPreviewCopy } from './history';

// Listeners this page registered and has not removed yet. A reload drops the page's callbacks but not the listeners on
// the Rust side, so the next event for one of them logs "Couldn't find callback id". unlistenAll removes them first.
const live = new Set<UnlistenFn>();

export async function listen<T>(
    event: EventName,
    handler: EventCallback<T>,
    options?: Options,
): Promise<UnlistenFn> {
    if (isPreviewCopy()) return () => {};
    const { listen: real } = await import('@tauri-apps/api/event');
    const stop = await real<T>(event, handler, options);
    live.add(stop);
    return () => {
        live.delete(stop);
        stop();
    };
}

/** Removes every listener of this page. Call before the page reloads. */
export async function unlistenAll(): Promise<void> {
    const stops = [...live];
    live.clear();
    await Promise.allSettled(stops.map(async (stop) => stop()));
}
