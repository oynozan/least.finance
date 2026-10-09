import { encodeFunctionData, erc20Abi, parseEther, type Address } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { expect, inject, test } from "vitest";
import { createSourceClients } from "../../src/crosschain/chains.ts";
import { coinByKey } from "../../src/crosschain/catalog.ts";
import { sourceChain } from "../support/source-chains.ts";

const randomAddress = () => privateKeyToAddress(generatePrivateKey());

test("the clients read each chain from its own RPC", async () => {
    const clients = createSourceClients({
        ethereum: ["http://127.0.0.1:1", inject("ethereumUrl")],
        bnb: [inject("bnbUrl")],
    });
    expect(clients.ethereum.chain?.id).toBe(1);
    expect(clients.bnb.chain?.id).toBe(56);
    expect(await clients.ethereum.getChainId()).toBe(1);
    expect(await clients.bnb.getChainId()).toBe(56);
});

test.each([
    ["ethereum:USDC", () => sourceChain(inject("ethereumUrl"), 1)],
    ["bnb:USDT", () => sourceChain(inject("bnbUrl"), 56)],
] as const)("%s: a stand-in token reports balances and the owner can send with it", async (key, chainFor) => {
    const chain = chainFor();
    const token = coinByKey(key).token as Address;
    const [owner, other] = [randomAddress(), randomAddress()];
    await chain.fund(owner, "2");
    await chain.installToken(token);
    await chain.setTokenBalance(token, owner, 1_234_567n);

    const balanceOf = (account: Address) =>
        chain.client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    expect(await balanceOf(owner)).toBe(1_234_567n);
    expect(await balanceOf(other)).toBe(0n);

    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [other, 1n] });
    const hashes = await chain.sendTxs(owner, [
        { to: token, data: approve, value: 0n },
        { to: other, data: "0x", value: parseEther("0.5") },
    ]);
    expect(hashes).toHaveLength(2);
    for (const hash of hashes) {
        expect(await chain.client.getTransactionReceipt({ hash })).toMatchObject({ status: "success" });
    }
    expect(await chain.client.getBalance({ address: other })).toBe(parseEther("0.5"));
});
