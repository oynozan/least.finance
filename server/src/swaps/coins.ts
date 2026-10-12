/** The nine networks swaps run on, with the coins pinned on each by address. This file has no imports because the client loads it at runtime. */

export type NetworkId =
    "ethereum" | "arbitrum" | "base" | "optimism" | "polygon" | "bnb" | "avalanche" | "arc" | "solana";

/** `chainId` is LI.FI's id for the network. */
export type SwapNetwork = { id: NetworkId; name: string; chainId: number; kind: "evm" | "solana" };

/** `reserve` is the gas kept out of the cap, in coin units, and only native gas coins have one. */
export type CoinEntry = {
    network: NetworkId;
    address: string;
    decimals: number;
    label?: string;
    wrapped?: true;
    reserve?: number;
};

export type SwapCoin = { symbol: string; name: string; home: NetworkId; entries: readonly CoinEntry[] };

export const NATIVE_EVM = "0x0000000000000000000000000000000000000000";
export const NATIVE_SOLANA = "11111111111111111111111111111111";

export const NETWORKS: readonly SwapNetwork[] = [
    { id: "ethereum", name: "Ethereum", chainId: 1, kind: "evm" },
    { id: "arbitrum", name: "Arbitrum", chainId: 42161, kind: "evm" },
    { id: "base", name: "Base", chainId: 8453, kind: "evm" },
    { id: "optimism", name: "Optimism", chainId: 10, kind: "evm" },
    { id: "polygon", name: "Polygon", chainId: 137, kind: "evm" },
    { id: "bnb", name: "BNB Chain", chainId: 56, kind: "evm" },
    { id: "avalanche", name: "Avalanche", chainId: 43114, kind: "evm" },
    { id: "arc", name: "Arc", chainId: 5042, kind: "evm" },
    { id: "solana", name: "Solana", chainId: 1151111081099710, kind: "solana" },
];

/** In the picker's order. */
export const COINS: readonly SwapCoin[] = [
    {
        symbol: "ETH",
        name: "Ethereum",
        home: "ethereum",
        entries: [
            { network: "ethereum", address: NATIVE_EVM, decimals: 18, reserve: 0.002 },
            { network: "arbitrum", address: NATIVE_EVM, decimals: 18, reserve: 0.0002 },
            { network: "base", address: NATIVE_EVM, decimals: 18, reserve: 0.0002 },
            { network: "optimism", address: NATIVE_EVM, decimals: 18, reserve: 0.0002 },
            {
                network: "polygon",
                address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
                decimals: 18,
                label: "WETH",
                wrapped: true,
            },
            {
                network: "bnb",
                address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
                decimals: 18,
                label: "Binance-Peg ETH",
                wrapped: true,
            },
            {
                network: "avalanche",
                address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB",
                decimals: 18,
                label: "WETH.e",
                wrapped: true,
            },
            {
                network: "arc",
                address: "0x128cC466B61f542da60c70e3aA11c10e19B84EDB",
                decimals: 18,
                label: "WETH",
                wrapped: true,
            },
            {
                network: "solana",
                address: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
                decimals: 8,
                label: "Wormhole ETH",
                wrapped: true,
            },
        ],
    },
    {
        symbol: "SOL",
        name: "Solana",
        home: "solana",
        entries: [
            { network: "solana", address: NATIVE_SOLANA, decimals: 9, reserve: 0.01 },
            {
                network: "ethereum",
                address: "0xD31a59c85aE9D8edEFeC411D448f90841571b89c",
                decimals: 9,
                label: "Wormhole SOL",
                wrapped: true,
            },
            {
                network: "bnb",
                address: "0x570A5D26f7765Ecb712C0924E4De545B89fD43dF",
                decimals: 18,
                label: "Binance-Peg SOL",
                wrapped: true,
            },
            {
                network: "arbitrum",
                address: "0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07",
                decimals: 9,
                label: "Wrapped SOL",
                wrapped: true,
            },
            {
                network: "base",
                address: "0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82",
                decimals: 9,
                label: "Bridged SOL",
                wrapped: true,
            },
            {
                network: "polygon",
                address: "0xd93f7E271cB87c23AaA73edC008A79646d1F9912",
                decimals: 9,
                label: "Wormhole SOL",
                wrapped: true,
            },
        ],
    },
    {
        symbol: "BTC",
        name: "Bitcoin",
        home: "ethereum",
        entries: [
            { network: "ethereum", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, label: "WBTC" },
            { network: "arbitrum", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, label: "WBTC" },
            { network: "optimism", address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", decimals: 8, label: "WBTC" },
            { network: "polygon", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8, label: "WBTC" },
            { network: "base", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, label: "cbBTC" },
            { network: "bnb", address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18, label: "BTCB" },
            {
                network: "avalanche",
                address: "0x152b9d0FdC40C096757F570A51E494bd4b943E50",
                decimals: 8,
                label: "BTC.b",
            },
            { network: "arc", address: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0", decimals: 8, label: "cirBTC" },
        ],
    },
    {
        symbol: "USDC",
        name: "USD Coin",
        home: "arc",
        entries: [
            { network: "arc", address: "0x3600000000000000000000000000000000000000", decimals: 6, reserve: 0.01 },
            { network: "ethereum", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
            { network: "arbitrum", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
            { network: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
            { network: "optimism", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6 },
            { network: "polygon", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
            { network: "bnb", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
            { network: "avalanche", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6 },
            { network: "solana", address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
        ],
    },
    {
        symbol: "USDT",
        name: "Tether",
        home: "ethereum",
        entries: [
            { network: "ethereum", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
            { network: "arbitrum", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
            { network: "base", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
            { network: "optimism", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6 },
            { network: "polygon", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
            { network: "bnb", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
            { network: "avalanche", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6 },
            { network: "solana", address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
        ],
    },
    {
        symbol: "BNB",
        name: "BNB",
        home: "bnb",
        entries: [{ network: "bnb", address: NATIVE_EVM, decimals: 18, reserve: 0.002 }],
    },
    {
        symbol: "LINK",
        name: "Chainlink",
        home: "ethereum",
        entries: [
            { network: "ethereum", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 },
            { network: "arbitrum", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18 },
            { network: "base", address: "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196", decimals: 18 },
            { network: "optimism", address: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6", decimals: 18 },
            { network: "polygon", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18 },
            { network: "bnb", address: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD", decimals: 18 },
            { network: "avalanche", address: "0x5947BB275c521040051D82396192181b413227A3", decimals: 18 },
        ],
    },
    {
        symbol: "DOGE",
        name: "Dogecoin",
        home: "bnb",
        entries: [
            {
                network: "bnb",
                address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43",
                decimals: 8,
                label: "Binance-Peg DOGE",
            },
        ],
    },
    {
        symbol: "AVAX",
        name: "Avalanche",
        home: "avalanche",
        entries: [{ network: "avalanche", address: NATIVE_EVM, decimals: 18, reserve: 0.02 }],
    },
    {
        symbol: "ARB",
        name: "Arbitrum",
        home: "arbitrum",
        entries: [
            { network: "arbitrum", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
            { network: "ethereum", address: "0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1", decimals: 18 },
        ],
    },
    {
        symbol: "OP",
        name: "Optimism",
        home: "optimism",
        entries: [{ network: "optimism", address: "0x4200000000000000000000000000000000000042", decimals: 18 }],
    },
];
