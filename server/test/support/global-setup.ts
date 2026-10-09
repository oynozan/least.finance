import type { TestProject } from "vitest/node";
import { startAnvil } from "./anvil.ts";
import { startMongo } from "./mongo.ts";

declare module "vitest" {
    export interface ProvidedContext {
        mongoUri: string;
        anvilUrl: string;
    }
}

/** One database server and one chain for the whole run; each test file gets its own database. */
export default async function setup(project: TestProject) {
    const [mongo, anvil] = await Promise.all([startMongo(), startAnvil()]);
    project.provide("mongoUri", mongo.uri);
    project.provide("anvilUrl", anvil.url);
    return async () => {
        await Promise.all([mongo.stop(), anvil.stop()]);
    };
}
