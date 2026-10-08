import type { IntentOf } from "@/lib/sentence";
import { registry } from "./context";
import type { IntentType, TransactionIntent } from "./intent";
import { perp } from "./operations/perp";
import { prediction } from "./operations/prediction";
import { spot } from "./operations/spot";
import { swap } from "./operations/swap";

/**
 * Every operation, in the order their verbs appear in the verb picker.
 * Adding a transaction type is one operation file plus one entry here.
 */
const operations = [swap, spot, perp, prediction] as const;

export const TRADE = registry(operations, { lead: "I want to" });

export const DEFAULT_VERB = "swap";

// Compile-time checks that the registry covers exactly the intents in
// intent.ts: no operation produces anything else, and none is missing.
type Produced = IntentOf<(typeof operations)[number]>;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const covered: Equal<Produced["type"], IntentType> = true;
const exact: [Produced] extends [TransactionIntent] ? true : false = true;
void covered;
void exact;
