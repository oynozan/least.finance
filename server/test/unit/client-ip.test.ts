import { describe, expect, it } from "vitest";
import { clientIp } from "../../src/socket/sockets.ts";

const REMOTE = "10.0.0.1";

describe("clientIp", () => {
    it("ignores X-Forwarded-For when no proxy is trusted", () => {
        expect(clientIp("1.1.1.1, 2.2.2.2", REMOTE, 0)).toBe(REMOTE);
    });

    it("uses the socket address when there is no header", () => {
        expect(clientIp(undefined, REMOTE, 1)).toBe(REMOTE);
        expect(clientIp("", REMOTE, 1)).toBe(REMOTE);
    });

    it("takes the last entry with one proxy", () => {
        expect(clientIp("9.9.9.9, 1.1.1.1", REMOTE, 1)).toBe("1.1.1.1");
    });

    it("takes the second to last entry with two proxies", () => {
        expect(clientIp("9.9.9.9, 1.1.1.1, 2.2.2.2", REMOTE, 2)).toBe("1.1.1.1");
    });

    it("joins repeated headers", () => {
        expect(clientIp(["9.9.9.9", "1.1.1.1, 2.2.2.2"], REMOTE, 2)).toBe("1.1.1.1");
    });

    it("is not fooled by entries a client spoofs on the left", () => {
        expect(clientIp("6.6.6.6, 7.7.7.7, 1.1.1.1", REMOTE, 1)).toBe("1.1.1.1");
    });

    it("falls back to the leftmost entry when the chain is shorter than the hops", () => {
        expect(clientIp("1.1.1.1", REMOTE, 3)).toBe("1.1.1.1");
        expect(clientIp("1.1.1.1, 2.2.2.2", REMOTE, 5)).toBe("1.1.1.1");
    });

    it("skips empty entries", () => {
        expect(clientIp(" , 1.1.1.1 ,, ", REMOTE, 1)).toBe("1.1.1.1");
    });
});
