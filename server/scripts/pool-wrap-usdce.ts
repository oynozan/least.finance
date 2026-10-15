/**
 * Wraps the USDC.e the pool's deposit wallet holds into pUSD through Polymarket's gasless relayer: approve the Onramp,
 * then wrap. Native USDC wrapping is paused on the Onramp, so bridged USDC.e is the way in.
 *
 *   node --env-file=.env scripts/pool-wrap-usdce.ts
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { AssetType } from "@polymarket/client";
import { prepareGaslessTransaction, updateBalanceAllowance } from "@polymarket/client/actions";
import { createPublicClient, encodeFunctionData, erc20Abi, formatUnits, http, parseAbi, type Address } from "viem";
import { polygon } from "viem/chains";
import { loadConfig } from "../src/config.ts";
import { createPolymarketClient, createPoolSigner } from "../src/predictions/polymarket-trader.ts";
import { POLYGON } from "../src/predictions/pool-moves.ts";

const USDCE: Address = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ramps = parseAbi(["function wrap(address asset, address to, uint256 amount)"]);

const config = loadConfig();
const client = await createPolymarketClient(config);
const owner = createPoolSigner(config, new AsyncLocalStorage());
const wallet = client.account.wallet as Address;
const chain = createPublicClient({ chain: polygon, transport: http(config.POLYGON_RPC_URL) });
const balanceOf = (token: Address) =>
    chain.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] });

const amount = await balanceOf(USDCE);
console.log(`Deposit wallet ${wallet} holds ${formatUnits(amount, 6)} USDC.e`);
if (amount === 0n) process.exit(0);

const calls = [
    { to: USDCE, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [POLYGON.onramp, amount] }) },
    {
        to: POLYGON.onramp as Address,
        data: encodeFunctionData({ abi: ramps, functionName: "wrap", args: [USDCE, wallet, amount] }),
    },
];
const workflow = await prepareGaslessTransaction(client, { calls, metadata: "Wrap USDC.e into pUSD" });
let step = await workflow.next();
while (!step.done) {
    const request = step.value;
    if (request.kind === "requestAddress") step = await workflow.next(await owner.getAddress());
    else if (request.kind === "signGaslessTypedData")
        step = await workflow.next(await owner.signTypedData(request.payload));
    else throw new Error(`the relayer workflow asked for ${request.kind}`);
}
console.log(`Submitted to the relayer: ${step.value.transactionId ?? "no transaction id"}`);

for (let i = 0; i < 24; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const pusd = await balanceOf(POLYGON.pusd as Address);
    if (pusd > 0n) {
        await updateBalanceAllowance(client, { assetType: AssetType.COLLATERAL });
        console.log(`pUSD now ${formatUnits(pusd, 6)}; the CLOB balance is synced`);
        process.exit(0);
    }
}
console.log("No pUSD yet after two minutes; check the relayer transaction");
