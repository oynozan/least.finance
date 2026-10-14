import { createHash, randomUUID } from "node:crypto";
import { findAssociatedTokenPda } from "@solana-program/token";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { bytesToHex, concatHex, pad, toHex, type Address, type Hex } from "viem";
import { AppError } from "../../errors.ts";
import { FORWARD_HOOK_DATA } from "../../withdrawals/cctp-burn.ts";
import { SOLANA_USDC_MINT } from "../../withdrawals/solana-recipient.ts";
import { toArcWei, type Coin } from "../catalog.ts";
import type { Iris } from "../iris.ts";
import type { BridgeProvider, BridgeStatus, Quote, QuoteRequest } from "./types.ts";

/** The CCTP v2 programs on Solana, from Circle's solana-cctp-contracts. */
export const TOKEN_MESSENGER_MINTER_V2 = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const MESSAGE_TRANSMITTER_V2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ARC_USDC_ERC20: Address = "0x3600000000000000000000000000000000000000";
/** Standard finality, the speed the quoted fee is for. */
const MIN_FINALITY_THRESHOLD = 2000;
const WEI_PER_UNIT = 10n ** 12n;
/** Rough time for Solana to finalize, Circle to attest and the forwarder to mint. */
const ETA_SECONDS = 1200;

/** Anchor's instruction discriminator: the first 8 bytes of sha256("global:<name>"). */
const BURN_DISCRIMINATOR = createHash("sha256").update("global:deposit_for_burn_with_hook").digest().subarray(0, 8);

type Key = { pubkey: string; isSigner: boolean; isWritable: boolean };
type Logger = { error: (fields: object, message: string) => void };

const u32 = (n: number) => toHex(n, { size: 4 }).slice(2).match(/../g)!.reverse().join("");
const u64 = (n: bigint) => toHex(n, { size: 8 }).slice(2).match(/../g)!.reverse().join("");

async function pda(seeds: (string | Uint8Array)[], programAddress: string) {
    const [found] = await getProgramDerivedAddress({
        programAddress: address(programAddress),
        seeds: seeds.map((seed) => (typeof seed === "string" ? new TextEncoder().encode(seed) : seed)),
    });
    return found;
}

/** The burn instruction's accounts in the program's order. The message account is a fresh signer the app supplies. */
async function burnKeys(owner: string, arcDomain: number): Promise<Key[]> {
    const ownerBytes = Uint8Array.from(getAddressEncoder().encode(address(owner)));
    const mint = SOLANA_USDC_MINT;
    const [burnAccount] = await findAssociatedTokenPda({
        owner: address(owner),
        mint: address(mint),
        tokenProgram: address(TOKEN_PROGRAM),
    });
    const tm = TOKEN_MESSENGER_MINTER_V2;
    const key = (pubkey: string, isWritable = false, isSigner = false): Key => ({ pubkey, isSigner, isWritable });
    return [
        key(owner, false, true),
        key(owner, true, true),
        key(await pda(["sender_authority"], tm)),
        key(burnAccount, true),
        key(await pda(["denylist_account", ownerBytes], tm)),
        key(await pda(["message_transmitter"], MESSAGE_TRANSMITTER_V2), true),
        key(await pda(["token_messenger"], tm)),
        key(await pda(["remote_token_messenger", String(arcDomain)], tm)),
        key(await pda(["token_minter"], tm)),
        key(await pda(["local_token", Uint8Array.from(getAddressEncoder().encode(address(mint)))], tm), true),
        key(mint, true),
        key(SYSTEM_PROGRAM, true, true),
        key(MESSAGE_TRANSMITTER_V2),
        key(tm),
        key(TOKEN_PROGRAM),
        key(SYSTEM_PROGRAM),
        key(await pda(["__event_authority"], tm)),
        key(tm),
    ];
}

function burnData(input: { amount: bigint; arcDomain: number; recipient: Address; maxFee: bigint }): Hex {
    return concatHex([
        bytesToHex(BURN_DISCRIMINATOR),
        `0x${u64(input.amount)}`,
        `0x${u32(input.arcDomain)}`,
        pad(input.recipient, { size: 32 }),
        pad("0x", { size: 32 }),
        `0x${u64(input.maxFee)}`,
        `0x${u32(MIN_FINALITY_THRESHOLD)}`,
        `0x${u32(32)}`,
        FORWARD_HOOK_DATA,
    ]);
}

/** Solana USDC deposits through CCTP v2: the wallet burns, and Circle's forwarder mints on Arc at the deposit address. */
export function createCctp(options: { iris: Iris; arcDomain: 26; solanaDomain: 5; logger?: Logger }): BridgeProvider {
    const { iris, arcDomain, solanaDomain, logger } = options;
    const reported = new Set<string>();

    return {
        name: "cctp",

        supports: (coin: Coin) => coin.key === "solana:USDC",

        async quote({ coin, amount, sender, recipient, refundTo }: QuoteRequest): Promise<Quote> {
            const { med, high } = await iris.depositFee();
            const maxFee = high / WEI_PER_UNIT;
            if (amount <= maxFee) throw new AppError("bad_request", "That's too small to cover the fee.");
            return {
                provider: "cctp",
                ref: `cctp-${randomUUID()}`,
                coin: coin.key,
                amountIn: amount,
                usdcOut: toArcWei(amount, coin.decimals) - med,
                etaSeconds: ETA_SECONDS,
                destinationToken: ARC_USDC_ERC20,
                recipient,
                refundTo,
                txs: [
                    {
                        kind: "solana",
                        instructions: [
                            {
                                programId: TOKEN_MESSENGER_MINTER_V2,
                                keys: await burnKeys(sender, arcDomain),
                                data: burnData({ amount, arcDomain, recipient, maxFee }),
                            },
                        ],
                        lookupTables: [],
                    },
                ],
            };
        },

        async status(_quote, signature): Promise<BridgeStatus> {
            if (!signature) return { stage: "waiting" };
            const message = await iris.message({ domain: solanaDomain, burnTxHash: signature });
            if (message?.status === "complete" && message.forwardTxHash) {
                return { stage: "filled", fillTxHash: message.forwardTxHash as Hex };
            }
            if (message?.status === "failed" && !reported.has(signature)) {
                reported.add(signature);
                logger?.error({ signature }, "A CCTP deposit burned on Solana but never minted on Arc");
            }
            return { stage: "pending" };
        },
    };
}
