import { useMemo } from "react";
import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import { getBase58Decoder } from "@solana/kit";
import type { SwapSigner } from "./account-client";

const base58 = getBase58Decoder();

/** Signs and sends with the linked Solana wallet at `address` through Privy, which hands the transaction to the wallet's own Wallet Standard feature. */
export function useSolanaSigner(address: string | undefined): SwapSigner["solana"] | undefined {
    const { wallets } = useWallets();
    const { signAndSendTransaction } = useSignAndSendTransaction();
    const wallet = address ? wallets.find((w) => w.address === address) : undefined;
    return useMemo(
        () =>
            wallet
                ? {
                      address: wallet.address,
                      signAndSend: async (transaction: Uint8Array) => {
                          const { signature } = await signAndSendTransaction({
                              transaction,
                              wallet,
                              chain: "solana:mainnet",
                          });
                          return base58.decode(signature);
                      },
                  }
                : undefined,
        [wallet, signAndSendTransaction],
    );
}
