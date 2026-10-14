import { describe, expect, it } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
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

    it("exposes the operator at index 0 while signerAt(0) stays refused", () => {
        expect(keyring.operator().address).toBe(mnemonicToAccount(MNEMONIC, { addressIndex: 0 }).address);
        expect(() => keyring.signerAt(0)).toThrow(/Bad deposit index/);
    });

    it("a perp address never equals a deposit address", () => {
        const deposits = new Set<string>();
        for (let i = 0; i <= 50; i++) {
            if (i > 0) deposits.add(keyring.addressAt(i));
        }
        deposits.add(keyring.operator().address.toLowerCase());
        for (let i = 0; i <= 50; i++) expect(deposits.has(keyring.perpAddressAt(i))).toBe(false);
    });

    it("perpAddressAt(0) is the master and differs from operator()", () => {
        expect(keyring.perpAddressAt(0)).toBe(keyring.perpSignerAt(0).address.toLowerCase());
        expect(keyring.perpAddressAt(0)).not.toBe(keyring.operator().address.toLowerCase());
        expect(keyring.perpAddressAt(0)).toBe(
            mnemonicToAccount(MNEMONIC, { accountIndex: 1, addressIndex: 0 }).address.toLowerCase(),
        );
    });

    it.each([-1, 1.5])("perpSignerAt rejects %s", (index) => {
        expect(() => keyring.perpSignerAt(index)).toThrow(/Bad perp index/);
        expect(() => keyring.perpAddressAt(index)).toThrow(/Bad perp index/);
    });
});
