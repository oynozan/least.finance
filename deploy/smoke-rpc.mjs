// A stand-in Arc JSON-RPC node for the smoke stack: right chain ID, a fixed head, no logs.
import { createServer } from "node:http";

const answers = { eth_chainId: "0x13b2", eth_blockNumber: "0x10", eth_getLogs: [] };
const answer = ({ id, method }) => ({ jsonrpc: "2.0", id, result: answers[method] ?? null });

createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
        const call = JSON.parse(body || "{}");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(Array.isArray(call) ? call.map(answer) : answer(call)));
    });
}).listen(8545, "0.0.0.0");
