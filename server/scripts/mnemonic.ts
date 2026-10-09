/** Prints a fresh 24-word BIP-39 phrase for DEPOSIT_MNEMONIC. */
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

console.log(generateMnemonic(wordlist, 256));
