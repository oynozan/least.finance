/**
 * What the user asked for, normalized and independent of how it was
 * phrased. This is what execution (not built yet) will consume.
 * USD amounts are decimal strings, so no float rounding sneaks in.
 */
export type TransactionIntent =
    | {
          type: "swap";
          fromToken: string;
          toToken: string;
          amountUSD: string;
      }
    | {
          type: "spot";
          side: "buy" | "sell";
          token: string;
          amountUSD: string;
      }
    | {
          type: "perp";
          side: "long" | "short";
          asset: string;
          leverage: number;
          collateralUSD: string;
      }
    | {
          type: "prediction";
          marketId: string;
          outcomeId: string;
          amountUSD: string;
      };

export type IntentType = TransactionIntent["type"];
