/** The body of a response up to maxBytes, or null when it is bigger. */
export async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
    if (Number(res.headers.get("content-length")) > maxBytes) {
        await res.body?.cancel();
        return null;
    }
    if (!res.body) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks);
}
