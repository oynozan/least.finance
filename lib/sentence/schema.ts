import type { IntentOf, OperationDef, RuntimeOperation, Str, VerbDef } from "./types";

export type Registry<Intent, Terms extends Str, Ctx> = {
  /** Text before the verb in every sentence: "I want to". */
  lead: string;
  operations: readonly RuntimeOperation<Intent, Terms, Ctx>[];
  /** Every verb in order, with the operation it belongs to. */
  verbs: readonly { verb: VerbDef<Str, Str>; op: RuntimeOperation<Intent, Terms, Ctx> }[];
};

/**
 * Fixes a domain's shared terms and context once, so every operation and
 * the registry agree on them:
 *
 *   const { operation, registry } = schema<TradeTerms, TradeCtx>();
 */
export function schema<Terms extends Str, Ctx>() {
  /** Type-checks an operation against its own values, then erases them. */
  function operation<Id extends string, S extends Str, F extends Str, Intent>(
    def: OperationDef<Id, S, F, Intent, Terms, Ctx>,
  ): RuntimeOperation<Intent, Terms, Ctx> {
    // The single erasure point. Sound because the engine only ever hands an
    // operation values that came from its own defaults, specs and normalize.
    return def as unknown as RuntimeOperation<Intent, Terms, Ctx>;
  }

  function registry<const Ops extends readonly RuntimeOperation<unknown, Terms, Ctx>[]>(
    operations: Ops,
    options: { lead: string },
  ): Registry<IntentOf<Ops[number]>, Terms, Ctx> {
    type Op = RuntimeOperation<IntentOf<Ops[number]>, Terms, Ctx>;
    const verbs: { verb: VerbDef<Str, Str>; op: Op }[] = [];
    const seen = new Set<string>();

    for (const op of operations as readonly Op[]) {
      const terms = new Set<string>();
      for (const [slot, spec] of Object.entries(op.slots)) {
        if (slot === "verb") throw new Error(`${op.id}: the slot name "verb" is reserved`);
        if (spec.term && terms.has(spec.term)) {
          throw new Error(`${op.id}: the term "${spec.term}" is bound to two slots`);
        }
        if (spec.term) terms.add(spec.term);
      }
      for (const verb of op.verbs) {
        if (seen.has(verb.id)) throw new Error(`The verb "${verb.id}" is defined twice`);
        seen.add(verb.id);
        verbs.push({ verb, op });
      }
    }

    return { lead: options.lead, operations: operations as readonly Op[], verbs };
  }

  return { operation, registry };
}

export function findVerb<I, T extends Str, C>(registry: Registry<I, T, C>, verbId: string) {
  const entry = registry.verbs.find((v) => v.verb.id === verbId);
  if (!entry) throw new Error(`Unknown verb "${verbId}"`);
  return entry;
}
