// Opens a signed-in socket.io connection through Caddy and checks it upgrades to a websocket.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import https from "node:https";

const require = createRequire(new URL("../server/package.json", import.meta.url));
const { io } = require("socket.io-client");
const { SignJWT, importPKCS8 } = require("jose");

const host = process.env.SMOKE_API_HOST;
const port = process.env.SMOKE_PORT;
const appId = process.env.SMOKE_PRIVY_APP_ID;
const key = await importPKCS8(readFileSync(process.env.PRIVY_KEY_FILE, "utf8"), "ES256");
const token = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setSubject("did:privy:smoke")
    .setIssuer("privy.io")
    .setAudience(appId)
    .setExpirationTime("5m")
    .sign(key);

// The smoke hostnames resolve to this machine, and Caddy's internal CA isn't trusted.
const agent = new https.Agent({
    rejectUnauthorized: false,
    lookup: (_name, _options, done) => done(null, [{ address: "127.0.0.1", family: 4 }]),
});
const socket = io(`https://${host}:${port}`, {
    auth: { token },
    agent,
    extraHeaders: { Origin: process.env.SMOKE_SITE_ORIGIN },
    reconnection: false,
    timeout: 10_000,
});

const timer = setTimeout(() => fail("timed out"), 15_000);
function fail(reason) {
    console.error(`socket check failed: ${reason}`);
    process.exit(1);
}
socket.on("connect_error", (error) => fail(error.message));
socket.on("connect", () => {
    socket.io.engine.on("upgrade", (transport) => {
        clearTimeout(timer);
        if (transport.name !== "websocket") fail(`upgraded to ${transport.name}`);
        socket.close();
        process.exit(0);
    });
    if (socket.io.engine.transport.name === "websocket") {
        clearTimeout(timer);
        socket.close();
        process.exit(0);
    }
});
