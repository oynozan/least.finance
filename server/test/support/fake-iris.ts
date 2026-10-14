import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PoolDirection } from "../../src/db/mongo.ts";

export type FakeIris = Awaited<ReturnType<typeof startFakeIris>>;

type Fee = { med: number; high: number };
type PoolFee = Fee & { bps?: number };

/** A Circle Iris stand-in: forward fees in USDC units (6 decimals) and per-burn messages set by the test. */
export async function startFakeIris() {
    const fees = { plain: { med: 127_000, high: 150_000 } as Fee, setup: { med: 286_000, high: 320_000 } as Fee };
    let depositFee: Fee = { med: 15_638, high: 15_763 };
    const poolFees: Record<PoolDirection, PoolFee> = {
        arc_to_polygon: { med: 70_969, high: 71_067 },
        polygon_to_arc: { med: 15_638, high: 16_288 },
    };
    /** Messages by `domain:hash`, where the domain is the source domain or `any`. */
    const messages = new Map<string, Record<string, unknown>>();
    const urls: string[] = [];
    let failure: number | null = null;

    const server = createServer((req, res) => {
        urls.push(req.url ?? "");
        if (failure !== null) {
            res.writeHead(failure).end("fail");
            return;
        }
        const url = new URL(req.url ?? "", "http://iris.test");
        const json = (body: unknown, status = 200) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
        };
        if (url.pathname.startsWith("/v2/burn/USDC/fees/")) {
            if (url.searchParams.get("forward") !== "true") return json({ error: "forward required" }, 400);
            const pool =
                url.pathname === "/v2/burn/USDC/fees/26/7"
                    ? poolFees.arc_to_polygon
                    : url.pathname === "/v2/burn/USDC/fees/7/26"
                      ? poolFees.polygon_to_arc
                      : null;
            const toArc = url.pathname === "/v2/burn/USDC/fees/5/26";
            const fee =
                pool ??
                (toArc
                    ? depositFee
                    : url.searchParams.get("includeRecipientSetup") === "true"
                      ? fees.setup
                      : fees.plain);
            return json([
                { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 1, high: 1 } },
                {
                    finalityThreshold: 2000,
                    minimumFee: pool?.bps ?? 0,
                    forwardFee: { low: fee.med - 1000, med: fee.med, high: fee.high },
                },
            ]);
        }
        if (url.pathname.startsWith("/v2/messages/")) {
            const hash = url.searchParams.get("transactionHash") ?? "";
            const domain = url.pathname.slice("/v2/messages/".length);
            const found = messages.get(`${domain}:${hash}`) ?? messages.get(`any:${hash}`);
            return found ? json({ messages: [found] }) : json({ code: "not_found" }, 404);
        }
        json({ error: "unknown" }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        /** Fees in USDC units; the second pair applies when the recipient needs its account set up. */
        setFees: (plain: Fee, setup: Fee) => {
            fees.plain = plain;
            fees.setup = setup;
        },
        /** The forward fee of a Solana to Arc burn, in USDC units. */
        setDepositFee: (fee: Fee) => void (depositFee = fee),
        /** The forward fee and the protocol's basis points (the 2000 row's `minimumFee`, default 0) of a pool burn. */
        setPoolFees: (direction: PoolDirection, fee: PoolFee) => void (poolFees[direction] = fee),
        /** A message served for the source `domain` only, or for any domain when it is omitted. */
        setMessage: (burnTxHash: string, message: Record<string, unknown>, domain?: number) =>
            void messages.set(`${domain ?? "any"}:${burnTxHash}`, message),
        /** The message of a burn Circle has seen but not yet forwarded. */
        setPending: (burnTxHash: string) => void messages.set(`any:${burnTxHash}`, { status: "pending_confirmations" }),
        /** The message of a burn Circle holds back for `reason` (for example `insufficient_fee`). */
        setDelayed: (burnTxHash: string, reason: string, domain?: number) =>
            void messages.set(`${domain ?? "any"}:${burnTxHash}`, {
                status: "pending_confirmations",
                delayReason: reason,
            }),
        /** The message of a burn whose mint landed as `forwardTxHash`, with the executed fee in units when given. */
        setForwarded: (
            burnTxHash: string,
            forwardTxHash: string,
            extra: { domain?: number; feeExecuted?: string | number } = {},
        ) =>
            void messages.set(`${extra.domain ?? "any"}:${burnTxHash}`, {
                status: "complete",
                forwardState: "CONFIRMED",
                forwardTxHash,
                ...(extra.feeExecuted === undefined
                    ? {}
                    : { decodedMessage: { decodedMessageBody: { feeExecuted: String(extra.feeExecuted) } } }),
            }),
        /** The message of a burn whose forward failed. */
        setForwardFailed: (burnTxHash: string) =>
            void messages.set(`any:${burnTxHash}`, { status: "complete", forwardState: "FAILED" }),
        /** Every request line received so far. */
        requests: () => urls,
        failWith: (status: number | null) => void (failure = status),
        stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
