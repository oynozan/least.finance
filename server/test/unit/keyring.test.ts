import { describe, expect, it } from "vitest";
import { mnemonicToAccount } from "viem/accounts";
import { base58 } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import { createKeyring } from "../../src/accounts/keyring.ts";
import { slip10Ed25519, solanaAddressOf } from "../../src/accounts/slip10.ts";

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

    it("derives the inventory wallet at m/44'/60'/3'/0/0", () => {
        expect(keyring.inventoryEvm().address).toBe(
            mnemonicToAccount(MNEMONIC, { accountIndex: 3, addressIndex: 0 }).address,
        );
    });

    it("keeps the inventory wallet off every deposit, treasury and perp address", () => {
        const inventory = keyring.inventoryEvm().address.toLowerCase();
        const others = new Set<string>([keyring.operator().address.toLowerCase()]);
        for (let i = 0; i <= 50; i++) {
            if (i > 0) others.add(keyring.addressAt(i));
            others.add(keyring.perpAddressAt(i));
            others.add(mnemonicToAccount(MNEMONIC, { accountIndex: 2, addressIndex: i }).address.toLowerCase());
        }
        expect(others.has(inventory)).toBe(false);
    });

    it("derives a Solana inventory address that is stable and 32 bytes of base58", () => {
        const solana = keyring.inventorySolana();
        expect(createKeyring(MNEMONIC).inventorySolana().address).toBe(solana.address);
        expect(base58.decode(solana.address)).toHaveLength(32);
        expect(solana.seed).toHaveLength(32);
        expect(solanaAddressOf(solana.seed)).toBe(solana.address);
    });

    it("derives Solana keys by SLIP-0010, matching the published vectors", () => {
        const seed = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
        expect(Buffer.from(slip10Ed25519(seed, "m")).toString("hex")).toBe(
            "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
        );
        expect(Buffer.from(slip10Ed25519(seed, "m/0'")).toString("hex")).toBe(
            "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
        );
        expect(Buffer.from(slip10Ed25519(seed, "m/0'/1'/2'/2'/1000000000'")).toString("hex")).toBe(
            "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793",
        );
        const master = slip10Ed25519(seed, "m");
        expect(solanaAddressOf(master)).toBe(
            base58.encode(Buffer.from("a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed", "hex")),
        );
        expect(() => slip10Ed25519(seed, "m/0")).toThrow(/hardened/);
    });

    it("keeps the Solana inventory seed off the standard Solana account paths", () => {
        const seed = keyring.inventorySolana().seed;
        for (const account of [0, 1, 2]) {
            expect(Buffer.from(slip10Ed25519(mnemonicToSeedSync(MNEMONIC), `m/44'/501'/${account}'/0'`))).not.toEqual(
                Buffer.from(seed),
            );
        }
    });
});
