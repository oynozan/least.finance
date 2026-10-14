import {
    AccountRole,
    address,
    appendTransactionMessageInstructions,
    blockhash,
    compileTransaction,
    compressTransactionMessageUsingAddressLookupTables,
    createTransactionMessage,
    generateKeyPair,
    getAddressFromPublicKey,
    getTransactionDecoder,
    getTransactionEncoder,
    partiallySignTransaction,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type Address,
    type Instruction,
} from "@solana/kit";
import type { SolanaInstruction } from "@/server/src/protocol";

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
/** The Compute Budget program's SetComputeUnitLimit discriminator. */
const SET_COMPUTE_UNIT_LIMIT = 2;
/** Added when a quote sets no limit; the network's own default for one instruction. */
const DEFAULT_COMPUTE_UNITS = 200_000;

const roleOf = ({ isSigner, isWritable }: { isSigner: boolean; isWritable: boolean }) =>
    isSigner
        ? isWritable
            ? AccountRole.WRITABLE_SIGNER
            : AccountRole.READONLY_SIGNER
        : isWritable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY;

function toInstruction(instruction: SolanaInstruction): Instruction {
    const hex = instruction.data.slice(2);
    const data = Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
    return {
        programAddress: address(instruction.programId),
        accounts: instruction.keys.map((key) => ({ address: address(key.pubkey), role: roleOf(key) })),
        data,
    };
}

const setsComputeLimit = (instruction: Instruction) =>
    instruction.programAddress === COMPUTE_BUDGET && instruction.data?.[0] === SET_COMPUTE_UNIT_LIMIT;

/** A compute-unit-limit instruction: the discriminator, then the units as a little-endian u32. */
function computeUnitLimit(units: number): Instruction {
    const data = new Uint8Array(5);
    data[0] = SET_COMPUTE_UNIT_LIMIT;
    new DataView(data.buffer).setUint32(1, units, true);
    return { programAddress: COMPUTE_BUDGET, data };
}

/** A v0 transaction paid by `payer`, ready for the wallet to sign: the instructions as given (with a compute-unit limit first when none is set), compressed against the lookup tables. */
export function buildDepositTransaction(input: {
    payer: string;
    blockhash: { blockhash: string; lastValidBlockHeight: number };
    instructions: SolanaInstruction[];
    lookupTables: { address: string; addresses: string[] }[];
}): Uint8Array {
    const instructions = input.instructions.map(toInstruction);
    if (!instructions.some(setsComputeLimit)) instructions.unshift(computeUnitLimit(DEFAULT_COMPUTE_UNITS));
    const tables: Record<Address, Address[]> = {};
    for (const table of input.lookupTables) tables[address(table.address)] = table.addresses.map((a) => address(a));
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(input.payer), m),
        (m) =>
            setTransactionMessageLifetimeUsingBlockhash(
                {
                    blockhash: blockhash(input.blockhash.blockhash),
                    lastValidBlockHeight: BigInt(input.blockhash.lastValidBlockHeight),
                },
                m,
            ),
        (m) => appendTransactionMessageInstructions(instructions, m),
        (m) => compressTransactionMessageUsingAddressLookupTables(m, tables),
    );
    return Uint8Array.from(getTransactionEncoder().encode(compileTransaction(message)));
}

/** The address a quote puts where it needs a signer only the app can supply (a one-off key). */
const FRESH_SIGNER = "11111111111111111111111111111111";

/** The instructions with every fresh-signer placeholder swapped for one new key's address, and that key. */
export async function withFreshSigners(
    instructions: SolanaInstruction[],
): Promise<{ instructions: SolanaInstruction[]; keyPairs: CryptoKeyPair[] }> {
    const keyPairs: CryptoKeyPair[] = [];
    let fresh: string | null = null;
    const out: SolanaInstruction[] = [];
    for (const instruction of instructions) {
        const keys: SolanaInstruction["keys"] = [];
        for (const key of instruction.keys) {
            if (!key.isSigner || key.pubkey !== FRESH_SIGNER) {
                keys.push(key);
                continue;
            }
            if (fresh === null) {
                const keyPair = await generateKeyPair();
                keyPairs.push(keyPair);
                fresh = await getAddressFromPublicKey(keyPair.publicKey);
            }
            keys.push({ ...key, pubkey: fresh });
        }
        out.push({ ...instruction, keys });
    }
    return { instructions: out, keyPairs };
}

/** The transaction with the one-off keys' signatures filled in, left for the wallet to add its own. */
export async function signWithFreshKeys(bytes: Uint8Array, keyPairs: CryptoKeyPair[]): Promise<Uint8Array> {
    if (keyPairs.length === 0) return bytes;
    const signed = await partiallySignTransaction(keyPairs, getTransactionDecoder().decode(bytes));
    return Uint8Array.from(getTransactionEncoder().encode(signed));
}
