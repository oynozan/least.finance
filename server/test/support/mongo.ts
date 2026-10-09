import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const SYSTEM_MONGOD = ["/opt/homebrew/bin/mongod", "/usr/local/bin/mongod", "/usr/bin/mongod"];

/** A throwaway single-node replica set (deposits need transactions), on the system mongod when there is one. */
export async function startMongo() {
    const systemBinary = process.env.MONGOMS_SYSTEM_BINARY ?? SYSTEM_MONGOD.find((path) => existsSync(path));
    const replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: "wiredTiger" },
        binary: systemBinary ? { systemBinary, version: versionOf(systemBinary) } : undefined,
    });
    return { uri: replSet.getUri(), stop: () => replSet.stop().then(() => undefined) };
}

/** Telling mongodb-memory-server the version up front stops it warning about a mismatch. */
function versionOf(binary: string) {
    const match = /db version v(\d+\.\d+\.\d+)/.exec(execFileSync(binary, ["--version"], { encoding: "utf8" }));
    return match?.[1];
}
