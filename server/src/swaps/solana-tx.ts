import { base58, base64 } from "@scure/base";

const SIGNATURE_BYTES = 64;
const KEY_BYTES = 32;
const HEADER_BYTES = 3;
const VERSION_FLAG = 0x80;

// Solana's compact-u16: seven bits per byte, low group first, at most three bytes
function compactU16(bytes: Uint8Array, offset: number): { value: number; next: number } {
    let value = 0;
    for (let index = 0; index < 3; index++) {
        const byte = bytes[offset + index];
        if (byte === undefined) throw new Error("The Solana transaction ends early");
        value |= (byte & 0x7f) << (7 * index);
        if ((byte & VERSION_FLAG) === 0) return { value, next: offset + index + 1 };
    }
    throw new Error("The Solana transaction has a bad length");
}

/** The fee payer of a base64 legacy or v0 wire transaction: the first static account key of its message. */
export function solanaFeePayer(data: string): string {
    const bytes = base64.decode(data);
    const signatures = compactU16(bytes, 0);
    let offset = signatures.next + signatures.value * SIGNATURE_BYTES;

    const first = bytes[offset];
    if (first === undefined) throw new Error("The Solana transaction has no message");
    // A versioned message starts with a prefix byte that a legacy message's signature count never reaches
    if (first & VERSION_FLAG) offset += 1;
    offset += HEADER_BYTES;

    const keys = compactU16(bytes, offset);
    const payer = bytes.subarray(keys.next, keys.next + KEY_BYTES);
    if (keys.value < 1 || payer.length < KEY_BYTES) throw new Error("The Solana transaction has no fee payer");
    return base58.encode(payer);
}
