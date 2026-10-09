import { describe, expect, it } from "vitest";
import { createKeyring } from "../../src/accounts/keyring.ts";

const MNEMONIC = "test test test test test test test test test test test junk";
const keyring = createKeyring(MNEMONIC);

describe("keyring", () => {
    it("derives the well-known addresses, lowercased", () => {
        expect(keyring.addressAt(1)).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
        expect(keyring.addressAt(2)).toBe("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
    });

    it("signs as the same address it hands out", () => {
        expect(keyring.signerAt(1).address).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
        expect(keyring.signerAt(2).address.toLowerCase()).toBe(keyring.addressAt(2));
    });

    it("derives the same address every time", () => {
        expect(createKeyring(MNEMONIC).addressAt(7)).toBe(keyring.addressAt(7));
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])("rejects the index %s", (index) => {
        expect(() => keyring.addressAt(index)).toThrow(/Bad deposit index/);
        expect(() => keyring.signerAt(index)).toThrow(/Bad deposit index/);
    });
});
