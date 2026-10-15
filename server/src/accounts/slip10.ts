import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import { base58, base64urlnopad } from "@scure/base";

const HARDENED = 0x80000000;
// The PKCS#8 header that wraps a 32-byte Ed25519 seed
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** The Ed25519 key at a fully hardened SLIP-0010 path such as "m/44'/501'/3'/0'". */
export function slip10Ed25519(seed: Uint8Array, path: string): Uint8Array {
    const steps = path.split("/");
    if (steps[0] !== "m") throw new Error(`Bad derivation path: ${path}`);
    let node = createHmac("sha512", "ed25519 seed").update(seed).digest();
    for (const step of steps.slice(1)) {
        const match = /^(\d+)'$/.exec(step);
        const index = match ? Number(match[1]) : Number.NaN;
        if (!Number.isSafeInteger(index) || index >= HARDENED) throw new Error(`Ed25519 paths are hardened: ${path}`);
        const child = Buffer.alloc(37);
        node.copy(child, 1, 0, 32);
        child.writeUInt32BE(index + HARDENED, 33);
        node = createHmac("sha512", node.subarray(32)).update(child).digest();
    }
    return new Uint8Array(node.subarray(0, 32));
}

/** A Solana address is the base58 of the Ed25519 public key. */
export function solanaAddressOf(seed: Uint8Array): string {
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
    const x = createPublicKey(key).export({ format: "jwk" }).x;
    if (!x) throw new Error("Couldn't read the Ed25519 public key");
    return base58.encode(base64urlnopad.decode(x));
}
