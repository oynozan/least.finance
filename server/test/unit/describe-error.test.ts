import { HttpRequestError } from "viem";
import { expect, test } from "vitest";
import { describeError } from "../../scripts/describe-error.ts";

test("an operator script sees the cause chain with every URL cut to its host", () => {
    const cause = new HttpRequestError({ url: "https://rpc.example.com/v2/SECRETKEY", details: "fetch failed" });
    const text = describeError(new Error("Couldn't read the float", { cause }));
    expect(text).toContain("Couldn't read the float <- ");
    expect(text).toContain("HTTP request failed.");
    expect(text).not.toContain("SECRETKEY");
});

test("a thrown string is printed as it is", () => {
    expect(describeError("boom")).toBe("boom");
});
