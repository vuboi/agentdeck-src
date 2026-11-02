// What to do when an agent turn ends in an error, so a long piece of work is not cut off half way: try again (a
// passing fault), or let the next agent (another provider) of the chain carry on. This module only plans: it never
// changes an account. Account switching is the opt-in auto-switch in events.svelte.ts (per connector, per custom
// provider); when it is off, a limit or sign-out moves the work to another provider here, never to another account.
// Free of stores and Tauri so plain node can test it; events.svelte.ts acts on the answer.
import { credentialScope } from '../../agents/credential-scope';

export type FailureKind =
    | 'limit'
    | 'transient'
    | 'auth'
    | 'missing'
    | 'conversation'
    | 'stopped'
    | 'other';

const STOPPED = /^stopped$/i;
// The CLI no longer has the conversation an id names (a run stopped before it wrote anything, a session cleaned up).
const NO_CONVERSATION =
    /(?:\b(?:no|unknown)\s+(?:rollout|conversation|session|thread)\b.{0,120}\b(?:found|exist)|\b(?:rollout|conversation|session|thread)\b.{0,120}\b(?:not found|does not exist|doesn't exist|missing))/i;
// A usage or rate limit of the account: waiting minutes or hours, or another account, is the only way through.
const LIMIT =
    /usage limit|rate.?limit|rate_limit|quota|\b429\b|too many requests|limit (?:reached|exceeded)|reached (?:your|the) [\w -]*?(?:usage|rate|plan|message|5-?hour|weekly) limit|exceeded your (?:current )?(?:quota|usage|limit)|insufficient_quota|credit balance|out of credits|resets? (?:at|in)\b|try again (?:at|in) \d|5-?hour limit|weekly limit/i;
// The sign-in is gone: the same agent fails again until the user logs in.
const AUTH =
    /\b401\b|unauthori[sz]ed|not (?:logged|signed) in|please (?:log|sign) ?in|log ?in (?:again|required)|login required|authentication (?:failed|error|required)|invalid (?:api[ _-]?key|x-api-key|token)|(?:token|session|credentials?) (?:has )?expired|re-?authenticate|run .*\/login/i;
// The CLI is not there to run.
const MISSING =
    /could not start|not installed|command not found|is not recognized as an internal|ENOENT|no such file or directory.*(?:claude|codex|opencode|agy|antigravity)/i;
// A fault of the moment: the service is busy, the network dropped. The same turn usually works a moment later.
const TRANSIENT =
    /overloaded|\b529\b|\b50[0234]\b|internal server error|bad gateway|service unavailable|gateway time-?out|timed? ?out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network error|connection (?:reset|refused|closed|error)|fetch failed|stream (?:ended|closed|error)|temporarily unavailable/i;

/** The kind of an error a turn ended with. The order matters: a limit message often says "try again" too. */
export function classifyFailure(message: string): FailureKind {
    const text = message.trim();
    if (STOPPED.test(text)) return 'stopped';
    if (LIMIT.test(text)) return 'limit';
    if (AUTH.test(text)) return 'auth';
    if (MISSING.test(text)) return 'missing';
    if (NO_CONVERSATION.test(text)) return 'conversation';
    if (TRANSIENT.test(text)) return 'transient';
    return 'other';
}

export type Recovery =
    | { action: 'retry'; delayMs: number }
    | { action: 'fallback'; agent: string }
    | { action: 'stop'; reason: string };

export type RecoveryInput = {
    kind: FailureKind;
    /** Retries already made for this piece of work (the same agent). */
    retries: number;
    /** The agents to carry on with, in order of preference, each one available now (installed, with models, room). */
    chain: string[];
    /** The agent that failed. */
    current: string;
    /** Agents this piece of work already ran on. */
    tried: string[];
};

/** Waits before each retry of a passing fault: a few seconds, then longer. */
export const RETRY_DELAYS = [3000, 12000];
/** Most agents one piece of work moves through before it stops and says so. */
export const MAX_HOPS = 3;

/** What to do now. Pure: the caller acts on it and counts the attempts. */
export function planRecovery(input: RecoveryInput): Recovery {
    const { kind } = input;
    if (kind === 'stopped')
        return { action: 'stop', reason: 'stopped by the user' };
    if (kind === 'transient' && input.retries < RETRY_DELAYS.length)
        return { action: 'retry', delayMs: RETRY_DELAYS[input.retries] };
    // The conversation is gone: the caller starts a new one (with what was said), so the next try needs no wait.
    if (kind === 'conversation' && input.retries < 1)
        return { action: 'retry', delayMs: 0 };
    // An unknown fault is tried once more before the work moves on: it may have been a hiccup of the CLI.
    if (kind === 'other' && input.retries < 1)
        return { action: 'retry', delayMs: RETRY_DELAYS[0] };
    // A limit or a sign-out belongs to the credential: every route that spends the same one is skipped, not only this model.
    const failedScope = credentialScopeOf(input.current);
    const next = nextAgent(
        input.chain,
        input.current,
        input.tried,
        kind === 'limit' || kind === 'auth'
            ? (route) => credentialScopeOf(route) === failedScope
            : undefined,
    );
    if (next && input.tried.length < MAX_HOPS)
        return { action: 'fallback', agent: next };
    const why =
        kind === 'limit'
            ? 'every agent of the chain is at its limit or unavailable'
            : kind === 'auth'
              ? 'the sign-in ran out and no other agent is available'
              : 'no other agent is available to carry on';
    return { action: 'stop', reason: why };
}

/** The first agent of the chain after the failed one that this work has not run on yet; wraps to the start. */
export function nextAgent(
    chain: string[],
    current: string,
    tried: string[],
    skip?: (agent: string) => boolean,
): string | undefined {
    const at = chain.indexOf(current);
    const ordered =
        at < 0 ? chain : [...chain.slice(at + 1), ...chain.slice(0, at)];
    return ordered.find(
        (agent) =>
            agent !== current && !tried.includes(agent) && !skip?.(agent),
    );
}

/**
 * The credential a route spends: its provider, or for a custom connector its provider id (the chain key starts with it).
 * Antigravity's sign-in is the `agy` one. Routes with the same scope share one limit and one sign-in.
 */
export function credentialScopeOf(route: string): string {
    const [provider = '', ...model] = route.split('|');
    return credentialScope(provider, model.join('|'));
}

/**
 * Resolves true once `ms` have passed, and false at once when `signal` aborts first (the timer is cleared). A stopped
 * wait never fires its callback, so nothing runs after the user's Stop.
 */
export function waitUnlessAborted(
    ms: number,
    signal: AbortSignal,
): Promise<boolean> {
    return new Promise((resolve) => {
        if (signal.aborted) {
            resolve(false);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/** What the chat shows (and the next turn is told) about the recovery, one line. */
export function recoveryNote(
    kind: FailureKind,
    recovery: Recovery,
    labels: { from: string; to?: string },
): string {
    const cause =
        kind === 'limit'
            ? `${labels.from} hit its usage limit`
            : kind === 'auth'
              ? `${labels.from} is signed out`
              : kind === 'missing'
                ? `${labels.from} could not start`
                : kind === 'conversation'
                  ? `${labels.from} no longer had its conversation`
                  : kind === 'transient'
                    ? `${labels.from} had a passing error`
                    : `${labels.from} stopped with an error`;
    switch (recovery.action) {
        case 'retry':
            return `${cause}: trying again in ${Math.round(recovery.delayMs / 1000)}s.`;
        case 'fallback':
            return `${cause}: ${labels.to ?? recovery.agent} carries on from here.`;
        case 'stop':
            return `${cause}, and the work could not continue: ${recovery.reason}.`;
    }
}

/**
 * The prompt that resumes interrupted work, for the same agent or the next one. The request is always repeated: a
 * retry may start a new conversation (the failed one never began), which would not have it otherwise.
 */
export function continuePrompt(
    reason: string,
    sameAgent: boolean,
    request = '',
): string {
    const head = sameAgent
        ? `[AgentDeck] Your previous turn was interrupted (${reason}). Carry on from where it stopped: check what is already done (git status, the files you changed) and do not redo finished steps. Then finish the user's request.`
        : `[AgentDeck] You are taking over this chat because the previous agent was interrupted (${reason}). Check what is already done in the working tree (git status, git diff) before you change anything, do not redo or undo its finished work, then finish the user's latest request.`;
    return request.trim()
        ? `${head}\n\nThe user's request:\n${request.trim()}`
        : head;
}
