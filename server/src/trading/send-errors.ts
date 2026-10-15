/** The network turned the transaction down, so it was never accepted and the amount can go back. */
export const refused = (error: unknown) =>
    (error instanceof Error && error.name === "SolanaRefusal") ||
    /insufficient funds|underpriced|gas too low|intrinsic gas|invalid sender|exceeds (the )?balance|execution reverted|transfer amount exceeds|invalid address/i.test(
        String(error),
    );

/** A node already holding or having mined the transaction: the receipt decides the rest. */
export const alreadySent = (error: unknown) => /already known|nonce too low|already imported/i.test(String(error));
