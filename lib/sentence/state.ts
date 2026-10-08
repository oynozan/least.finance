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
};

export type SentenceAction =
  | { type: "verb"; verbId: string }
  | { type: "slot"; slot: string; value: string };

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

function withTerms<T extends Str, C>(
  op: RuntimeOperation<unknown, T, C>,
  draft: Str,
  terms: Partial<T>,
): Partial<T> {
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
function enter<I, T extends Str, C>(
  registry: Registry<I, T, C>,
  state: SentenceState<T>,
  verbId: string,
  ctx: C,
): Str {
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

  next = op.normalize?.(next, { type: "enter", changed }, verb.fixed, ctx) ?? next;
  return next;
}

export function initialState<I, T extends Str, C>(
  registry: Registry<I, T, C>,
  verbId: string,
  ctx: C,
): SentenceState<T> {
  const empty: SentenceState<T> = { verbId, drafts: {}, terms: {} };
  const { op } = findVerb(registry, verbId);
  const draft = enter(registry, empty, verbId, ctx);
  return { verbId, drafts: { [op.id]: draft }, terms: withTerms(op, draft, {}) };
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
  if (value === null || value === current[action.slot]) return state;

  let draft: Str = { ...current, [action.slot]: value };
  draft =
    op.normalize?.(draft, { type: "slot", slot: action.slot, prev: current[action.slot] }, verb.fixed, ctx) ??
    draft;

  return {
    verbId: state.verbId,
    drafts: { ...state.drafts, [op.id]: draft },
    terms: withTerms(op, draft, state.terms),
  };
}
