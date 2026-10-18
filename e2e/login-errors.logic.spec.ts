import { expect, test } from "@playwright/test";
import { loginProblem } from "@/lib/wallet/login-errors";

test.describe("a failed sign-in", () => {
    test("says what Privy's code means", () => {
        expect(loginProblem("exited_auth_flow")).toBe("You closed the sign-in window.");
        expect(loginProblem("unknown_connect_wallet_error")).toContain("Unlock it");
        expect(loginProblem("missing_or_invalid_privy_app_id")).toContain("app id");
    });

    test("names a code it doesn't know instead of hiding it", () => {
        expect(loginProblem("something_new")).toBe("Couldn't sign in (something_new).");
    });
});
