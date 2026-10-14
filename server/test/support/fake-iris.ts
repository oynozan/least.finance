import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeIris = Awaited<ReturnType<typeof startFakeIris>>;

type Fee = { med: number; high: number };

/** A Circle Iris stand-in: forward fees in USDC units (6 decimals) and per-burn messages set by the test. */
export async function startFakeIris() {
    const fees = { plain: { med: 127_000, high: 150_000 } as Fee, setup: { med: 286_000, high: 320_000 } as Fee };
    let depositFee: Fee = { med: 15_638, high: 15_763 };
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
            const toArc = url.pathname === "/v2/burn/USDC/fees/5/26";
            const fee = toArc
                ? depositFee
                : url.searchParams.get("includeRecipientSetup") === "true"
                  ? fees.setup
                  : fees.plain;
            return json([
                { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 1, high: 1 } },
                {
                    finalityThreshold: 2000,
                    minimumFee: 0,
                    forwardFee: { low: fee.med - 1000, med: fee.med, high: fee.high },
                },
            ]);
        }
        if (url.pathname.startsWith("/v2/messages/")) {
            const found = messages.get(url.searchParams.get("transactionHash") ?? "");
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
        setMessage: (burnTxHash: string, message: Record<string, unknown>) => void messages.set(burnTxHash, message),
        /** The message of a burn Circle has seen but not yet forwarded. */
        setPending: (burnTxHash: string) => void messages.set(burnTxHash, { status: "pending_confirmations" }),
        /** The message of a burn whose mint landed on Solana as `forwardTxHash`. */
        setForwarded: (burnTxHash: string, forwardTxHash: string) =>
            void messages.set(burnTxHash, { status: "complete", forwardState: "CONFIRMED", forwardTxHash }),
        /** The message of a burn whose forward failed. */
        setForwardFailed: (burnTxHash: string) =>
            void messages.set(burnTxHash, { status: "complete", forwardState: "FAILED" }),
        /** Every request line received so far. */
        requests: () => urls,
        failWith: (status: number | null) => void (failure = status),
        stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}
