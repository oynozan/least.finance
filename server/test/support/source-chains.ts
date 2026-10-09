import {
    createTestClient,
    http,
    numberToHex,
    pad,
    parseUnits,
    publicActions,
    walletActions,
    type Address,
    type Hex,
} from "viem";
import { bsc, mainnet } from "viem/chains";

/** Returns `sload(calldataload(4))`: the first argument, read as a storage slot. */
const TOKEN_CODE = "0x6004355460005260206000f3";

/** Talks to a local Ethereum (1) or BNB Chain (56) the way a user's wallet would. */
export function sourceChain(url: string, chainId: 1 | 56) {
    const client = createTestClient({
        mode: "anvil",
        chain: chainId === 1 ? mainnet : bsc,
        transport: http(url),
        pollingInterval: 50,
    })
        .extend(publicActions)
        .extend(walletActions);

    return {
        client,
        /** Gives an address native coin to spend, and lets it send without a key. */
        async fund(address: Address, native: string) {
            await client.setBalance({ address, value: parseUnits(native, 18) });
            await client.impersonateAccount({ address });
        },
        /**
         * Puts a stand-in ERC-20 at `token` that answers `balanceOf(owner)` from the owner's storage slot
         * and accepts every other call, which is all balance reads and approvals need.
         */
        async installToken(token: Address) {
            await client.setCode({ address: token, bytecode: TOKEN_CODE });
        },
        /** Sets what the stand-in token's `balanceOf(owner)` returns. */
        async setTokenBalance(token: Address, owner: Address, units: bigint) {
            await client.setStorageAt({
                address: token,
                index: pad(owner, { size: 32 }),
                value: numberToHex(units, { size: 32 }),
            });
        },
        /** Sends transactions from an impersonated address in order, each mined before the next. */
        async sendTxs(from: Address, txs: { to: Address; data: Hex; value: bigint }[]): Promise<Hex[]> {
            const hashes: Hex[] = [];
            for (const tx of txs) {
                const hash = await client.sendTransaction({ account: from, ...tx, gas: 200_000n });
                await client.waitForTransactionReceipt({ hash });
                hashes.push(hash);
            }
            return hashes;
        },
    };
}
