import { sanitizeDecimal } from "./decimal";
import { findVerb, type Registry } from "./schema";
import type { RuntimeOperation, SlotSpec, Str } from "./types";

export type SentenceState<Terms extends Str> = {
    verbId: string;
    /**
     * Each visited operation's slot values, so switching back restores them.
     * Values a verb fixes (Buy's side) are derived from `verbId`, never stored.
     */
    drafts: Partial<Record<string, Str>>;
    /** The last value written to each shared term, by any operation. */
    terms: Partial<Terms>;
    /** What the person set with a slot action: the slots per operation, and the terms those slots are bound to. */
    chosen: Chosen;
};

export type Chosen = { slots: Partial<Record<string, readonly string[]>>; terms: readonly string[] };

export type SentenceAction = { type: "verb"; verbId: string } | { type: "slot"; slot: string; value: string };

/** What a slot will store for an incoming value, or null to ignore it. */
export function accept<Ctx>(
    spec: SlotSpec<Str, Ctx, string, string>,
    raw: string,
    values: Str,
    ctx: Ctx,
): string | null {
    if (spec.kind === "number") return sanitizeDecimal(raw, spec.decimals, spec.maxIntegerDigits);
    const choice = spec.choices(values, ctx).find((c) => c.value === raw);
    if (choice) return choice.disabled ? null : choice.value;
    return spec.custom?.parse(raw, values, ctx) ?? null;
}

/** `chosen` with this slot and its term added; the same object when both are there. */
function withChosen<I, T extends Str, C>(chosen: Chosen, op: RuntimeOperation<I, T, C>, slot: string): Chosen {
    const term = op.slots[slot].term;
    const here = chosen.slots[op.id] ?? [];
    const newSlot = !here.includes(slot);
    const newTerm = term !== undefined && !chosen.terms.includes(term);
    if (!newSlot && !newTerm) return chosen;
    return {
        slots: newSlot ? { ...chosen.slots, [op.id]: [...here, slot] } : chosen.slots,
        terms: newTerm ? [...chosen.terms, term] : chosen.terms,
    };
}

/** The slots of an operation the person set, or whose shared term they set anywhere. */
function chosenSlots<I, T extends Str, C>(state: SentenceState<T>, op: RuntimeOperation<I, T, C>): string[] {
    return Object.entries(op.slots)
        .filter(
            ([slot, spec]) =>
                state.chosen.slots[op.id]?.includes(slot) || (spec.term && state.chosen.terms.includes(spec.term)),
        )
        .map(([slot]) => slot);
}

function withTerms<T extends Str, C>(op: RuntimeOperation<unknown, T, C>, draft: Str, terms: Partial<T>): Partial<T> {
    const next: Partial<Str> = { ...terms };
    for (const [slot, spec] of Object.entries(op.slots)) {
        if (spec.term) next[spec.term] = draft[slot];
    }
    return next as Partial<T>;
}

/**
 * The values a verb starts with: its operation's draft (or defaults), with
 * shared terms carried over wherever the receiving slot accepts them, then
 * normalized. Terms win over the draft, so the latest amount and coin follow
 * the user from verb to verb.
 */
function enter<I, T extends Str, C>(registry: Registry<I, T, C>, state: SentenceState<T>, verbId: string, ctx: C): Str {
    const { op, verb } = findVerb(registry, verbId);
    let next: Str = { ...(state.drafts[op.id] ?? op.defaults(ctx)) };
    const changed: string[] = [];

    for (const [slot, spec] of Object.entries(op.slots)) {
        const shared = spec.term ? state.terms[spec.term] : undefined;
        if (shared === undefined || shared === next[slot]) continue;
        const accepted = accept(spec, shared, { ...next, ...verb.fixed }, ctx);
        if (accepted !== null) {
            next[slot] = accepted;
            changed.push(slot);
        }
    }

    next = op.normalize?.(next, { type: "enter", changed, chosen: chosenSlots(state, op) }, verb.fixed, ctx) ?? next;
    return next;
}

export function initialState<I, T extends Str, C>(
    registry: Registry<I, T, C>,
    verbId: string,
    ctx: C,
): SentenceState<T> {
    const empty: SentenceState<T> = { verbId, drafts: {}, terms: {}, chosen: { slots: {}, terms: [] } };
    const { op } = findVerb(registry, verbId);
    const draft = enter(registry, empty, verbId, ctx);
    return { ...empty, drafts: { [op.id]: draft }, terms: withTerms(op, draft, {}) };
}

export function reduce<I, T extends Str, C>(
    registry: Registry<I, T, C>,
    state: SentenceState<T>,
    action: SentenceAction,
    ctx: C,
): SentenceState<T> {
    if (action.type === "verb") {
        if (action.verbId === state.verbId) return state;
        const { op } = findVerb(registry, action.verbId);
        const draft = enter(registry, state, action.verbId, ctx);
        return {
            ...state,
            verbId: action.verbId,
            drafts: { ...state.drafts, [op.id]: draft },
            terms: withTerms(op, draft, state.terms),
        };
    }

    const { op, verb } = findVerb(registry, state.verbId);
    const current = state.drafts[op.id] ?? enter(registry, state, state.verbId, ctx);
    // Unknown slots include the verb's fixed values: those can't be set.
    const spec = Object.hasOwn(op.slots, action.slot) ? op.slots[action.slot] : undefined;
    if (!spec) return state;

    const value = accept(spec, action.value, { ...current, ...verb.fixed }, ctx);
    if (value === null) return state;
    const chosen = withChosen(state.chosen, op, action.slot);
    if (value === current[action.slot]) return chosen === state.chosen ? state : { ...state, chosen };

    let draft: Str = { ...current, [action.slot]: value };
    draft =
        op.normalize?.(draft, { type: "slot", slot: action.slot, prev: current[action.slot] }, verb.fixed, ctx) ??
        draft;

    return {
        verbId: state.verbId,
        drafts: { ...state.drafts, [op.id]: draft },
        terms: withTerms(op, draft, state.terms),
        chosen,
    };
}

/** The current operation's draft re-normalized for a changed context, so it re-fits only what the person didn't choose; the same state when nothing moves. */
export function refit<I, T extends Str, C>(
    registry: Registry<I, T, C>,
    state: SentenceState<T>,
    ctx: C,
): SentenceState<T> {
    const { op, verb } = findVerb(registry, state.verbId);
    const before = state.drafts[op.id];
    if (!before || !op.normalize) return state;
    const draft = op.normalize(before, { type: "refit", chosen: chosenSlots(state, op) }, verb.fixed, ctx);
    if (Object.keys(draft).every((key) => draft[key] === before[key])) return state;
    return { ...state, drafts: { ...state.drafts, [op.id]: draft }, terms: withTerms(op, draft, state.terms) };
}
