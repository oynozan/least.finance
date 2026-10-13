const round = (value: number) => Math.round(value * 100) / 100;

/** A smooth line through the points that never overshoots them (monotone cubic, Fritsch–Carlson). */
export function smoothPath(xy: readonly (readonly [number, number])[]): string {
    const n = xy.length;
    const slopes: number[] = [];
    for (let i = 0; i < n - 1; i++) slopes.push((xy[i + 1]![1] - xy[i]![1]) / (xy[i + 1]![0] - xy[i]![0] || 1));
    const tangents = xy.map((_, i) =>
        i === 0
            ? slopes[0]!
            : i === n - 1
              ? slopes[n - 2]!
              : slopes[i - 1]! * slopes[i]! <= 0
                ? 0
                : (slopes[i - 1]! + slopes[i]!) / 2,
    );
    for (let i = 0; i < n - 1; i++) {
        if (slopes[i] === 0) {
            tangents[i] = 0;
            tangents[i + 1] = 0;
            continue;
        }
        const a = tangents[i]! / slopes[i]!;
        const b = tangents[i + 1]! / slopes[i]!;
        const s = a * a + b * b;
        if (s > 9) {
            const k = 3 / Math.sqrt(s);
            tangents[i] = k * a * slopes[i]!;
            tangents[i + 1] = k * b * slopes[i]!;
        }
    }
    let path = `M${round(xy[0]![0])},${round(xy[0]![1])}`;
    for (let i = 0; i < n - 1; i++) {
        const [x0, y0] = xy[i]!;
        const [x1, y1] = xy[i + 1]!;
        const h = (x1 - x0) / 3;
        path += `C${round(x0 + h)},${round(y0 + h * tangents[i]!)} ${round(x1 - h)},${round(y1 - h * tangents[i + 1]!)} ${round(x1)},${round(y1)}`;
    }
    return path;
}
