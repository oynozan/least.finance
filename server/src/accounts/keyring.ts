import { mnemonicToSeedSync } from "@scure/bip39";
import type { Address } from "viem";
import { HDKey, hdKeyToAccount, type HDAccount } from "viem/accounts";
import { slip10Ed25519, solanaAddressOf } from "./slip10.ts";

/**
 * Derives every account's deposit address from one mnemonic, so only the
 * index is stored. The same keys will sign the account's trades later.
 */
export type Keyring = {
    /** Lowercase. */
    addressAt(index: number): Address;
    signerAt(index: number): HDAccount;
    /** The treasury: index 0, which no account's deposit address uses. */
    operator(): HDAccount;
    /** Index 0 is the Hyperliquid master float account; the path differs from the deposits'. */
    perpSignerAt(index: number): HDAccount;
    /** Lowercase. */
    perpAddressAt(index: number): Address;
    /** The wallet that holds the coins people trade, at m/44'/60'/3'/0/0: one address on every EVM network. */
    inventoryEvm(): HDAccount;
    /** The inventory wallet on Solana, at m/44'/501'/3'/0'; `seed` is the 32-byte Ed25519 private key. */
    inventorySolana(): { address: string; seed: Uint8Array };
};

export function createKeyring(mnemonic: string): Keyring {
    // The seed takes 2048 PBKDF2 rounds, so it's derived once.
    const masterSeed = mnemonicToSeedSync(mnemonic);
    const root = HDKey.fromMasterSeed(masterSeed);
    const signerAt = (index: number) => {
        if (!Number.isSafeInteger(index) || index < 1) throw new Error(`Bad deposit index: ${index}`);
        return hdKeyToAccount(root, { addressIndex: index });
    };
    const perpSignerAt = (index: number) => {
        if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Bad perp index: ${index}`);
        return hdKeyToAccount(root, { accountIndex: 1, addressIndex: index });
    };
    return {
        addressAt: (index) => signerAt(index).address.toLowerCase() as Address,
        signerAt,
        operator: () => hdKeyToAccount(root, { addressIndex: 0 }),
        perpSignerAt,
        perpAddressAt: (index) => perpSignerAt(index).address.toLowerCase() as Address,
        inventoryEvm: () => hdKeyToAccount(root, { accountIndex: 3, addressIndex: 0 }),
        inventorySolana: () => {
            const seed = slip10Ed25519(masterSeed, "m/44'/501'/3'/0'");
            return { address: solanaAddressOf(seed), seed };
        },
    };
}
