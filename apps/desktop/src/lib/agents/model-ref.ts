// One text form for "which provider, which model, which effort": `provider|model|effort` (effort optional). It is the
// route key of a fallback chain, a task route and a saved preference. Pure, so plain node can test it.
//
// Older forms are still read, never written:
//   - a custom provider's chat model, `<provider id>::<model>` (see models.svelte.ts customModelId)
//   - the same `|` form with the effort after a second `|` (already the canonical form)
// A bare model name (a reply that names only its model) has no provider here: it is not guessed.

export type ModelRef = { provider: string; model: string; effort?: string };

const SEP = '|';
const CUSTOM_SEP = '::';

/** The ref a text names, or null when it names no provider and no model. */
export function parseModelRef(
    text: string | null | undefined,
): ModelRef | null {
    const value = text?.trim();
    if (!value) return null;
    const custom = value.indexOf(CUSTOM_SEP);
    if (custom > 0 && !value.includes(SEP)) {
        const model = value.slice(custom + CUSTOM_SEP.length);
        return model ? { provider: value.slice(0, custom), model } : null;
    }
    const [provider, model, effort] = value.split(SEP);
    if (!provider || !model) return null;
    return effort ? { provider, model, effort } : { provider, model };
}

/** The canonical text of a ref: `provider|model`, with `|effort` when there is one. */
export function formatModelRef(ref: ModelRef): string {
    return ref.effort
        ? `${ref.provider}${SEP}${ref.model}${SEP}${ref.effort}`
        : `${ref.provider}${SEP}${ref.model}`;
}
