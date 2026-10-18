import { expect, test } from "vitest";
import { hostOf } from "../../src/db/mongo.ts";

test("a MongoDB URI is named by its host and never by its credentials", () => {
    expect(hostOf("mongodb://app:s3cret@db.internal:27017/least?replicaSet=rs0")).toBe("db.internal:27017");
    expect(hostOf("mongodb+srv://app:s3cret@cluster0.example.net/?retryWrites=true")).toBe("cluster0.example.net");
    expect(hostOf("mongodb://localhost:27017")).toBe("localhost:27017");
});
