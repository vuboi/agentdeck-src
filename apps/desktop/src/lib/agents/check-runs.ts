/**
 * Runs `start` once per key: a call while a run for the same key is still pending joins that run instead of starting
 * another. The key is released when the run settles, so a later call starts a fresh run.
 */
export function joinRun<T>(
    runs: Map<string, Promise<T>>,
    key: string,
    start: () => Promise<T>,
): Promise<T> {
    const running = runs.get(key);
    if (running) return running;
    const run = start().finally(() => {
        if (runs.get(key) === run) runs.delete(key);
    });
    runs.set(key, run);
    return run;
}
