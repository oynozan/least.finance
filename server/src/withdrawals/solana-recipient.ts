import { base58 } from "@scure/base";
import { findAssociatedTokenPda } from "@solana-program/token";
import { address } from "@solana/kit";
import { bytesToHex, type Hex } from "viem";
import { AppError } from "../errors.ts";
import type { SolanaRpc } from "../crosschain/solana.ts";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** A base58 address as the 32 bytes a CCTP message carries, 0x-prefixed. */
export function solanaBytes32(wallet: string): Hex {
    const bytes = base58.decode(wallet);
    if (bytes.length !== 32) throw new AppError("bad_request", "That isn't a wallet address.");
    return bytesToHex(bytes);
}

/** The wallet's associated USDC token account, which is where CCTP mints. */
export async function usdcAccountOf(wallet: string): Promise<string> {
    const [pda] = await findAssociatedTokenPda({
        owner: address(wallet),
        mint: address(SOLANA_USDC_MINT),
        tokenProgram: address(TOKEN_PROGRAM),
    });
    return pda;
}

/** Refuses a program-owned wallet; `setup` is true when the USDC account doesn't exist yet. */
export async function checkRecipient(rpc: SolanaRpc, wallet: string): Promise<{ usdcAccount: string; setup: boolean }> {
    solanaBytes32(wallet);
    const usdcAccount = await usdcAccountOf(wallet);
    const [walletInfo, tokenInfo] = await Promise.all([rpc.getAccountInfo(wallet), rpc.getAccountInfo(usdcAccount)]);
    if (walletInfo && walletInfo.owner !== SYSTEM_PROGRAM) {
        throw new AppError("bad_request", "That address can't receive USDC.");
    }
    return { usdcAccount, setup: tokenInfo === null };
}
