// Which CLI conversation a chat turn resumes, and which turns of the chat that conversation has not seen yet.
// Pure: no Tauri, no network, no stores. Tested with `node --experimental-strip-types --test`.
//
// The chat's turns form a ledger: turn N is `ledger[N - 1]`, its seq is N. Each provider keeps its own conversation,
// so a provider only needs the turns written since it last saw the ledger (`syncedSeq`).

/** Why a conversation starts anew: the account or the model changed, or a message was edited. */
export type Reason = 'account' | 'model' | 'edit';

/** One CLI conversation of a chat. `id` is '' until the CLI names it (Codex, Antigravity). */
export type Bound = {
    id: string;
    /** The CLI has this conversation (a turn was confirmed): a later turn may resume it. */
    started: boolean;
    /** The model the conversation runs on. */
    model?: string;
    /** The account epoch the conversation began under. */
    epoch?: number;
    /** Seq of the last ledger turn this conversation has seen. */
    syncedSeq: number;
};

/** One turn of the ledger. `agent` is the provider that wrote it; undefined for a user turn. */
export type LedgerTurn = { agent?: string };

export type ChatBindings = {
    /** The bound conversations, one per provider that has taken part in the chat. */
    bindings: Partial<Record<string, Bound>>;
    /** The turns before the one being sent. */
    ledger: LedgerTurn[];
};

export type Turn = {
    agent: string;
    model?: string;
    epoch: number;
    /** A background lane: its conversation is independent and never stored on the chat. */
    listener?: boolean;
    /** The message being sent replaces an earlier one: every conversation of the chat is closed. */
    edited?: boolean;
    /** The CLI switches model inside the same conversation (Claude's `set_model`), so a model change keeps it. */
    liveModel?: boolean;
    /** Mints the id of a new conversation the CLI takes from AgentDeck (Claude), given why it starts anew. Absent or
     *  '': the id stays '' until the CLI names it. */
    mint?: (reason?: Reason) => string;
};

export type Resolution = {
    /** The conversation this turn runs on. Stored on the chat unless `listener`. */
    binding: Bound;
    /** The turn resumes `binding` instead of starting a conversation. */
    resume: boolean;
    /** Ledger seqs the conversation must be told: the turns it has not seen. Its own turns are left out on resume. */
    catchUp: number[];
    /** Agents whose conversation ends with this turn. */
    closed: string[];
    /** Why the conversation starts anew, when it does: the account or model changed, or a message was edited. */
    reason?: Reason;
};

const seqsOf = (
    ledger: LedgerTurn[],
    keep: (turn: LedgerTurn, seq: number) => boolean,
) =>
    ledger.flatMap((turn, index) => (keep(turn, index + 1) ? [index + 1] : []));

/** The conversation of `turn` in `chat`, and what it must be told before the turn runs. */
export function resolveBinding(chat: ChatBindings, turn: Turn): Resolution {
    const fresh = (reason?: Reason): Bound => ({
        id: turn.mint?.(reason) ?? '',
        started: false,
        model: turn.model,
        epoch: turn.epoch,
        syncedSeq: 0,
    });
    const everything = seqsOf(chat.ledger, () => true);
    // A lane's prompt carries its own digest (see `startTurn`), so the lane's conversation is told nothing here.
    if (turn.listener)
        return { binding: fresh(), resume: false, catchUp: [], closed: [] };
    // An edit cuts the ledger: each conversation saw turns that are gone now, so each one starts anew.
    if (turn.edited)
        return {
            binding: fresh('edit'),
            resume: false,
            catchUp: everything,
            closed: Object.keys(chat.bindings),
            reason: 'edit',
        };
    const own = chat.bindings[turn.agent];
    if (!own)
        return {
            binding: fresh(),
            resume: false,
            catchUp: everything,
            closed: [],
        };
    const accountChanged = own.epoch !== undefined && own.epoch !== turn.epoch;
    const modelChanged =
        own.model !== undefined &&
        turn.model !== undefined &&
        own.model !== turn.model &&
        !turn.liveModel;
    if (accountChanged || modelChanged) {
        const reason: Reason = accountChanged ? 'account' : 'model';
        return {
            binding: fresh(reason),
            resume: false,
            catchUp: everything,
            closed: [turn.agent],
            reason,
        };
    }
    const resume = own.started && own.id !== '';
    // Resuming, the conversation already holds its own turns: only the other providers' turns since it last synced.
    const catchUp = resume
        ? seqsOf(
              chat.ledger,
              (entry, seq) => seq > own.syncedSeq && entry.agent !== turn.agent,
          )
        : everything;
    return {
        binding: { ...own, model: turn.model ?? own.model, epoch: turn.epoch },
        resume,
        catchUp,
        closed: [],
    };
}

/** The binding after a finished turn: it has seen every turn up to `lastSeq`, its own reply included. */
export function syncedThrough(binding: Bound, lastSeq: number): Bound {
    return { ...binding, syncedSeq: Math.max(binding.syncedSeq, lastSeq) };
}
