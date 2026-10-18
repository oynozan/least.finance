import type { TransactionIntent } from "./intent";

export type Submission = { status: "unsupported"; intent: TransactionIntent; message: string };

/**
 * Where execution will plug in. Nothing is sent anywhere, so the answer says so, and the
 * person is never shown a trade as done that was not made.
 */
export async function submitIntent(intent: TransactionIntent): Promise<Submission> {
    console.warn("Trade intent not executed: this trade type has no execution path", intent);
    return { status: "unsupported", intent, message: "This trade type isn't available yet. Nothing was spent." };
}
