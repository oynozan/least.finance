import { mnemonicToSeedSync } from "@scure/bip39";
import type { Address } from "viem";
import { HDKey, hdKeyToAccount, type HDAccount } from "viem/accounts";

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
};

export function createKeyring(mnemonic: string): Keyring {
    // The seed takes 2048 PBKDF2 rounds, so it's derived once.
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
    const signerAt = (index: number) => {
        if (!Number.isSafeInteger(index) || index < 1) throw new Error(`Bad deposit index: ${index}`);
        return hdKeyToAccount(root, { addressIndex: index });
    };
    return {
        addressAt: (index) => signerAt(index).address.toLowerCase() as Address,
        signerAt,
        operator: () => hdKeyToAccount(root, { addressIndex: 0 }),
    };
}
