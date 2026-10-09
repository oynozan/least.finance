import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** Arc rejects fees under 20 gwei, and so does this chain. */
const ARC_BASE_FEE = "20000000000";

function anvilBinary() {
    if (process.env.ANVIL_PATH) return process.env.ANVIL_PATH;
    const foundry = join(homedir(), ".foundry", "bin", "anvil");
    return existsSync(foundry) ? foundry : "anvil";
}

export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject()));
        });
    });
}

/** A local chain with Arc's chain ID, mining a block per transaction. */
export async function startAnvil(port?: number) {
    const chosen = port ?? (await freePort());
    const child = spawn(
        anvilBinary(),
        [
            "--chain-id",
            "5042",
            "--host",
            "127.0.0.1",
            "--port",
            String(chosen),
            "--block-base-fee-per-gas",
            ARC_BASE_FEE,
            "--silent",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const exited = new Promise<never>((_, reject) =>
        child.once("exit", (code) => reject(new Error(`anvil exited (${code}): ${stderr}`))),
    );
    child.once("error", () => undefined);

    const url = `http://127.0.0.1:${chosen}`;
    const ready = (async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
                });
                if (response.ok) return;
            } catch {
                // Not listening yet.
            }
            await sleep(100);
        }
        throw new Error("anvil didn't start. Install Foundry (https://getfoundry.sh) or set ANVIL_PATH.");
    })();
    await Promise.race([ready, exited]);

    return {
        url,
        stop: () =>
            new Promise<void>((resolve) => {
                if (child.exitCode !== null) return resolve();
                child.once("exit", () => resolve());
                child.kill("SIGTERM");
            }),
    };
}
