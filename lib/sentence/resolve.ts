import { isEntered } from "./decimal";
import { findVerb, type Registry } from "./schema";
import type { SentenceState } from "./state";
import type { Choice, Issue, Preview, Str } from "./types";

/**
 * One item of the rendered sentence. Keys are stable across verbs: words by
 * text and occurrence ("w:to:1" is the second "to"), the verb as "verb", and
 * slots by their shared term when bound, so a pill that means the same thing
 * in two operations is the same element and glides between them.
 * `glue` is punctuation that must stay on the item's line ("[10 USD].").
 */
export type SentencePart =
  | { kind: "word"; key: string; text: string; glue: string }
  | { kind: "verb"; key: "verb"; glue: string }
  | { kind: "slot"; key: string; slot: string; glue: string };

type SlotViewBase = {
  id: string;
  prompt: string;
  hint: string;
  /** The first issue on this slot, if any. */
  issue?: Issue;
};

export type ChoiceSlotView = SlotViewBase & {
  kind: "choice";
  value: string;
  selected?: Choice;
  choices: readonly Choice[];
  /** Present when the picker also takes a typed value. */
  custom?: {
    placeholder: string;
    suffix?: string;
    /** The value typed text would store, or null if it isn't allowed. */
    parse: (text: string) => string | null;
  };
  wide?: boolean;
};

export type NumberSlotView = SlotViewBase & {
  kind: "number";
  value: string;
  prefix?: string;
  suffix?: string;
  decimals: number;
  placeholder: string;
};

export type SlotView = ChoiceSlotView | NumberSlotView;

export type SentenceView<Intent> = {
  verb: { id: string; label: string };
  /** The verb picker's options, grouped. */
  verbChoices: Choice[];
  parts: SentencePart[];
  slots: Record<string, SlotView>;
  /** Issues on slots in the sentence, in reading order, then cross-slot ones. */
  issues: Issue[];
  /** The first issue that stops the intent, if any. */
  blocking?: Issue;
  /** Present only when nothing blocks. */
  intent: Intent | null;
  preview: Preview;
  /** The whole sentence as plain text, for announcements and summaries. */
  text: string;
  /** The action button's label once nothing blocks. */
  cta: string;
};

const TOKEN = /[.,!?;:]+|[^\s.,!?;:]+/g;
const PUNCTUATION = /^[.,!?;:]+$/;

export function resolve<I, T extends Str, C>(
  registry: Registry<I, T, C>,
  state: SentenceState<T>,
  ctx: C,
): SentenceView<I> {
  const { op, verb } = findVerb(registry, state.verbId);
  const draft = state.drafts[op.id] ?? op.defaults(ctx);
  const values: Str = { ...draft, ...verb.fixed };

  // Template -> keyed parts.
  const parts: SentencePart[] = [];
  const seen = new Map<string, number>();
  const items = [registry.lead, ...op.template(values, ctx)];
  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      for (const token of item.match(TOKEN) ?? []) {
        const prev = parts.at(-1);
        if (PUNCTUATION.test(token) && prev) {
          prev.glue += token;
          continue;
        }
        const word = token.toLowerCase();
        const n = seen.get(word) ?? 0;
        seen.set(word, n + 1);
        parts.push({ kind: "word", key: `w:${word}:${n}`, text: token, glue: "" });
      }
    } else if ("verb" in item) {
      parts.push({ kind: "verb", key: "verb", glue: "" });
    } else {
      const term = op.slots[item.slot].term;
      parts.push({
        kind: "slot",
        key: term ? `term:${term}` : `${op.id}:${item.slot}`,
        slot: item.slot,
        glue: "",
      });
    }
  }

  // Slots in the sentence, with their engine-derived issues.
  const slots: Record<string, SlotView> = {};
  const issues: Issue[] = [];
  for (const part of parts) {
    if (part.kind !== "slot") continue;
    const id = part.slot;
    const spec = op.slots[id];
    const value = values[id] ?? "";
    const slotIssues: Issue[] = [];

    if (spec.kind === "number") {
      if (!isEntered(value)) {
        slotIssues.push({ code: "missing", severity: "incomplete", slot: id, ...spec.missing });
      } else {
        const { min, max } = spec.bounds?.(values, ctx) ?? {};
        const amount = Number(value);
        if (min && amount < min.value) {
          slotIssues.push({ code: "min", severity: "error", slot: id, message: min.message, cta: min.cta });
        } else if (max && amount > max.value) {
          slotIssues.push({ code: "max", severity: "error", slot: id, message: max.message, cta: max.cta });
        }
      }
      slots[id] = {
        kind: "number",
        id,
        prompt: spec.prompt,
        hint: spec.hint,
        value,
        prefix: spec.prefix,
        suffix: spec.suffix,
        decimals: spec.decimals,
        placeholder: spec.placeholder,
      };
    } else {
      const choices = spec.choices(values, ctx);
      const custom = spec.custom;
      const typed = custom && value !== "" && custom.parse(value, values, ctx) === value;
      const selected =
        choices.find((c) => c.value === value) ?? (typed ? custom.choice(value, values, ctx) : undefined);
      // A value that is no longer offered (a market closed, a coin sold)
      // surfaces as an issue rather than being silently replaced.
      if (!selected || selected.disabled) {
        slotIssues.push({ code: "missing", severity: "incomplete", slot: id, ...spec.missing });
      }
      slots[id] = {
        kind: "choice",
        id,
        prompt: spec.prompt,
        hint: spec.hint,
        value,
        selected,
        choices,
        wide: spec.wide,
        custom: custom && {
          placeholder: custom.placeholder(values, ctx),
          suffix: custom.suffix,
          parse: (text) => custom.parse(text, values, ctx),
        },
      };
    }
    issues.push(...slotIssues);
  }

  for (const issue of op.check?.(values, ctx) ?? []) {
    if (!issue.slot || slots[issue.slot]) issues.push(issue);
  }
  for (const issue of issues) {
    const slot = issue.slot ? slots[issue.slot] : undefined;
    if (slot && !slot.issue) slot.issue = issue;
  }

  const blocking =
    issues.find((i) => i.severity === "error") ?? issues.find((i) => i.severity === "incomplete");

  const text = parts
    .map((part) => {
      let shown: string;
      if (part.kind === "word") shown = part.text;
      else if (part.kind === "verb") shown = verb.label;
      else {
        const slot = slots[part.slot];
        shown =
          slot.kind === "choice"
            ? (slot.selected?.label ?? "…")
            : `${slot.prefix ?? ""}${slot.value || "…"}${slot.suffix ?? ""}`;
      }
      return shown + part.glue;
    })
    .join(" ");

  return {
    verb: { id: verb.id, label: verb.label },
    verbChoices: registry.verbs.map(({ verb: v }) => ({
      value: v.id,
      label: v.label,
      description: v.hint,
      group: v.group,
      icon: v.icon,
    })),
    parts,
    slots,
    issues,
    blocking,
    intent: blocking ? null : op.toIntent(values, ctx),
    preview: op.preview(values, ctx),
    text,
    cta: verb.cta(values),
  };
}
