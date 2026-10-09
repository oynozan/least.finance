import type { TestProject } from "vitest/node";
import { startAnvil } from "./anvil.ts";
import { startMongo } from "./mongo.ts";

declare module "vitest" {
    export interface ProvidedContext {
        mongoUri: string;
        anvilUrl: string;
        ethereumUrl: string;
        bnbUrl: string;
    }
}

/**
 * One database server and one chain each for Arc, Ethereum and BNB Chain for the whole run;
 * each test file gets its own database.
 */
export default async function setup(project: TestProject) {
    const [mongo, anvil, ethereum, bnb] = await Promise.all([
        startMongo(),
        startAnvil(),
        startAnvil(undefined, { chainId: 1 }),
        startAnvil(undefined, { chainId: 56 }),
    ]);
    project.provide("mongoUri", mongo.uri);
    project.provide("anvilUrl", anvil.url);
    project.provide("ethereumUrl", ethereum.url);
    project.provide("bnbUrl", bnb.url);
    return async () => {
        await Promise.all([mongo.stop(), anvil.stop(), ethereum.stop(), bnb.stop()]);
    };
}
