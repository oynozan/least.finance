/**
 * The sentence engine's vocabulary. Nothing here knows about trading (or
 * React): a domain describes its operations with these types, and the
 * engine turns them into a sentence, validation and an intent.
 */

export type Str = Record<string, string>;

export type Tone = "gain" | "loss" | "neutral";

/** Opaque to the engine; the UI resolves `set` through its icon registry. */
export type IconRef = { set: string; id: string; tone?: Tone };

export type Choice<T extends string = string> = {
  value: T;
  /** Shown in the picker, and on the pill unless `short` is set. */
  label: string;
  /** Pill text where space is tight (narrow screens). */
  short?: string;
  /** A second line in the picker. */
  description?: string;
  /** Muted trailing text in the picker: a price, odds, a balance. */
  detail?: string;
  tone?: Tone;
  icon?: IconRef;
  /** Picker section this choice is listed under. */
  group?: string;
  /** Why it can't be picked; the choice is disabled when this is set. */
  disabled?: string;
};

/** A limit on a number slot, with the copy to show when it is crossed. */
export type Bound = {
  value: number;
  /** One line under the sentence: "That's more than your $42.10 of ETH." */
  message: string;
  /** Short label for the action button: "Not enough ETH". */
  cta: string;
};

type SlotBase<Term extends string> = {
  /** The picker title, or the number input's label: "Swap from which coin?" */
  prompt: string;
  /** What the slot means, read after its value: "Coin you pay with". */
  hint: string;
  /** Copy for when the slot has no usable value (empty, or no longer offered). */
  missing: { message: string; cta: string };
  /**
   * Binds the slot to a term shared across operations: its value carries
   * over when the verb changes, and its pill keeps its identity (it glides
   * to its new place instead of being replaced).
   */
  term?: Term;
};

export type ChoiceSpec<V, Ctx, T extends string, Term extends string> = SlotBase<Term> & {
  kind: "choice";
  choices: (values: V, ctx: Ctx) => readonly Choice<T>[];
};

export type NumberSpec<V, Ctx, Term extends string> = SlotBase<Term> & {
  kind: "number";
  prefix?: string;
  suffix?: string;
  decimals: number;
  placeholder: string;
  /** Typing is kept to this many digits before the decimal point. */
  maxIntegerDigits?: number;
  bounds?: (values: V, ctx: Ctx) => { min?: Bound; max?: Bound };
};

export type SlotSpec<V, Ctx, T extends string, Term extends string> =
  | ChoiceSpec<V, Ctx, T, Term>
  | NumberSpec<V, Ctx, Term>;

export type SlotKind = SlotSpec<Str, unknown, string, string>["kind"];

/** Marks where a template places the verb pill. */
export const VERB = { verb: true } as const;

/** Falsy items are dropped, so templates can include clauses conditionally. */
export type TemplateItem<K extends string> =
  | string
  | { slot: K }
  | typeof VERB
  | false
  | null
  | undefined;

/**
 * - incomplete: something still to fill in; shown quietly, blocks the intent.
 * - error: an invalid value; shown in the loss tone, blocks the intent.
 * - warning: worth knowing; never blocks.
 */
export type Severity = "incomplete" | "error" | "warning";

export type Issue<K extends string = string> = {
  code: string;
  severity: Severity;
  slot?: K;
  message: string;
  /** Short label for the action button while this issue blocks it. */
  cta?: string;
};

export type PreviewRow = {
  id: string;
  label: string;
  value: string;
  tone?: Tone;
  /** The rows that matter most ("You pay", "You get"); listed first, larger. */
  primary?: boolean;
};

export type Preview = {
  /** Context above the rows, e.g. a prediction market's full question. */
  title?: string;
  rows: PreviewRow[];
};

/** Why `normalize` is running: the verb was entered, or one slot changed. */
export type Cause<K extends string> =
  | { type: "enter"; changed: readonly K[] }
  | { type: "slot"; slot: K; prev: string };

export type VerbDef<F, V> = {
  id: string;
  /** Pill and picker label: "Long". */
  label: string;
  /** One plain line under the label in the picker. */
  hint: string;
  /** Picker section: "Trade", "Leverage"... */
  group: string;
  icon?: IconRef;
  /** Parameters this verb decides (Buy: side "buy"); never stored in drafts. */
  fixed: F;
  /** The action button's label once the sentence is complete: "Review 5x long". */
  cta: (values: V) => string;
};

/**
 * One operation, fully typed against its own values:
 * - S: the slot values (one string per slot, stored per operation),
 * - F: the values its verbs fix (e.g. `side`),
 * - Intent: the normalized transaction it produces.
 */
export type OperationDef<
  Id extends string,
  S extends Str,
  F extends Str,
  Intent,
  Terms extends Str,
  Ctx,
> = {
  id: Id;
  verbs: readonly [VerbDef<F, Readonly<S & F>>, ...VerbDef<F, Readonly<S & F>>[]];
  /** Every slot value has a spec: its type, allowed values and limits. */
  slots: {
    [K in keyof S & string]: SlotSpec<Readonly<S & F>, Ctx, S[K], keyof Terms & string>;
  };
  defaults: (ctx: Ctx) => S;
  template: (values: Readonly<S & F>, ctx: Ctx) => readonly TemplateItem<keyof S & string>[];
  /** Keeps the values consistent after any change (e.g. a swap's two coins never match). */
  normalize?: (next: S, cause: Cause<keyof S & string>, fixed: F, ctx: Ctx) => S;
  /** Rules across slots; per-slot limits come from the slot specs. */
  check?: (values: Readonly<S & F>, ctx: Ctx) => readonly Issue<keyof S & string>[];
  /** Only called by the engine, and only when nothing blocks. */
  toIntent: (values: Readonly<S & F>, ctx: Ctx) => Intent;
  preview: (values: Readonly<S & F>, ctx: Ctx) => Preview;
};

/** The erased form the registry stores; `Intent` stays visible. */
export type RuntimeOperation<Intent, Terms extends Str, Ctx> = {
  id: string;
  verbs: readonly VerbDef<Str, Str>[];
  slots: Record<string, SlotSpec<Str, Ctx, string, keyof Terms & string>>;
  defaults: (ctx: Ctx) => Str;
  template: (values: Str, ctx: Ctx) => readonly TemplateItem<string>[];
  normalize?: (next: Str, cause: Cause<string>, fixed: Str, ctx: Ctx) => Str;
  check?: (values: Str, ctx: Ctx) => readonly Issue[];
  toIntent: (values: Str, ctx: Ctx) => Intent;
  preview: (values: Str, ctx: Ctx) => Preview;
};

/** The intent an operation produces (a union, for a union of operations). */
export type IntentOf<Op> = Op extends { toIntent: (...args: never[]) => infer I } ? I : never;
