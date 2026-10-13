import { createTestClient, decodeFunctionData, http, pad, parseAbi, publicActions, type Address, type Hex } from "viem";

/**
 * Runtime code for a contract that logs its calldata (LOG0) and returns true, and reverts while storage slot 0 is nonzero:
 * SLOAD(0) JUMPI(revert) · CALLDATACOPY · LOG0 · MSTORE(1) RETURN(32) · JUMPDEST REVERT.
 */
const CODE: Hex = "0x600054601a57366000600037366000a0600160005260206000f35b60006000fd";

const abi = parseAbi([
    "function approve(address spender, uint256 amount)",
    "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

export type RecordedCall =
    | { name: "approve"; spender: Address; amount: bigint }
    | {
          name: "depositForBurnWithHook";
          amount: bigint;
          destinationDomain: number;
          mintRecipient: Hex;
          burnToken: Address;
          destinationCaller: Hex;
          maxFee: bigint;
          minFinalityThreshold: number;
          hookData: Hex;
      };

/** Puts a recording stand-in for the TokenMessengerV2 or the USDC ERC-20 view at `address` on a local chain. */
export async function installStub(url: string, address: Address) {
    const client = createTestClient({ mode: "anvil", transport: http(url) }).extend(publicActions);
    await client.setCode({ address, bytecode: CODE });
    await client.setStorageAt({ address, index: "0x0", value: pad("0x00", { size: 32 }) });
    return {
        address,
        /** Every call that went through, oldest first; reverted ones leave no log. */
        async calls(): Promise<RecordedCall[]> {
            const logs = await client.getLogs({ address, fromBlock: 0n });
            return logs.map((log) => {
                const { functionName, args } = decodeFunctionData({ abi, data: log.data });
                if (functionName === "approve") {
                    return { name: "approve", spender: args[0], amount: args[1] };
                }
                const [
                    amount,
                    destinationDomain,
                    mintRecipient,
                    burnToken,
                    destinationCaller,
                    maxFee,
                    threshold,
                    hook,
                ] = args;
                return {
                    name: "depositForBurnWithHook",
                    amount,
                    destinationDomain,
                    mintRecipient,
                    burnToken,
                    destinationCaller,
                    maxFee,
                    minFinalityThreshold: threshold,
                    hookData: hook,
                };
            });
        },
        /** Makes every call revert until told otherwise. */
        async revertCalls(on: boolean) {
            await client.setStorageAt({ address, index: "0x0", value: pad(on ? "0x01" : "0x00", { size: 32 }) });
        },
    };
}
