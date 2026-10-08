import type { TransactionIntent } from "./intent";

export type Submission = { status: "simulated"; intent: TransactionIntent };

/**
 * Where execution will plug in. For now nothing is sent anywhere: the
 * intent is logged and handed back.
 */
export async function submitIntent(intent: TransactionIntent): Promise<Submission> {
  console.info("Trade intent (not executed):", intent);
  return { status: "simulated", intent };
}
