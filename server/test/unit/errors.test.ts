import { describe, expect, it } from "vitest";
import { AppError, isAppError, toApiError } from "../../src/errors.ts";

describe("toApiError", () => {
    it("passes an AppError through", () => {
        expect(toApiError(new AppError("below_minimum", "Too small."))).toEqual({
            code: "below_minimum",
            message: "Too small.",
        });
    });

    it("hides the message of any other error", () => {
        const api = toApiError(new Error("connect ECONNREFUSED mongodb://user:pass@host"));
        expect(api).toEqual({ code: "internal", message: "Something went wrong on our side." });
        expect(JSON.stringify(api)).not.toContain("mongodb");
    });

    it("handles thrown non-errors", () => {
        expect(toApiError("boom").code).toBe("internal");
        expect(toApiError(undefined).code).toBe("internal");
    });
});

describe("AppError", () => {
    it("maps codes to HTTP statuses", () => {
        expect(new AppError("bad_request", "x").status).toBe(400);
        expect(new AppError("unauthorized", "x").status).toBe(401);
        expect(new AppError("rate_limited", "x").status).toBe(429);
        expect(new AppError("unavailable", "x").status).toBe(503);
        expect(new AppError("internal", "x").status).toBe(500);
    });

    it("is recognised by isAppError", () => {
        expect(isAppError(new AppError("forbidden", "x"))).toBe(true);
        expect(isAppError(new Error("x"))).toBe(false);
    });
});
