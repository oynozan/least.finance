import { z } from "zod";

// Gamma sends these three as JSON text, so decode them into arrays and fail the market if they aren't
const jsonList = <T extends z.ZodType>(item: T) =>
    z
        .string()
        .transform((text, ctx) => {
            try {
                return JSON.parse(text) as unknown;
            } catch {
                ctx.addIssue({ code: "custom", message: "not JSON" });
                return z.NEVER;
            }
        })
        .pipe(z.array(item));

// Prices come as numeric text ("0.84"), and a few fields arrive as numbers
const decimal = z.coerce.number().finite();
// An empty string would coerce to 0, which reads as a price of nothing rather than no price
const price = z.preprocess((value) => (value === "" ? null : value), decimal.nullish());

export const gammaMarket = z.object({
    id: z.string(),
    active: z.boolean(),
    closed: z.boolean(),
    acceptingOrders: z.boolean(),
    enableOrderBook: z.boolean(),
    endDate: z.string().nullish(),
    // Both are for the first outcome's token, and either is null while a side of the book is empty
    bestBid: price,
    bestAsk: price,
    orderMinSize: decimal,
    outcomes: jsonList(z.string()),
    outcomePrices: jsonList(decimal),
    clobTokenIds: jsonList(z.string()),
    groupItemTitle: z.string().nullish(),
    conditionId: z.string().nullish(),
    umaResolutionStatus: z.string().nullish(),
    sportsMarketType: z.string().nullish(),
    image: z.string().nullish(),
});

export const gammaEvent = z.object({
    id: z.string(),
    title: z.string(),
    image: z.string().nullish(),
    icon: z.string().nullish(),
    endDate: z.string().nullish(),
    startDate: z.string().nullish(),
    createdAt: z.string().nullish(),
    volume24hr: decimal.nullish(),
    // A market that fails its schema is skipped, so one odd prop never costs the whole event
    markets: z.array(gammaMarket.nullable().catch(null)).transform((markets) => markets.filter((m) => m !== null)),
});

export type GammaMarket = z.infer<typeof gammaMarket>;
export type GammaEvent = z.infer<typeof gammaEvent>;
