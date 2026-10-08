/**
 * Cleans typed or pasted text into a decimal string instead of blocking
 * keys: "$1,250.009" -> "1250.00", "007" -> "7", "." -> "0.", "10,5" -> "10.5".
 * A trailing "." is kept so typing "10." isn't undone mid-number.
 */
export function sanitizeDecimal(raw: string, decimals: number, maxIntegerDigits = 9): string {
  let text = raw.replace(/[^\d.,]/g, "");
  // A lone comma followed by up to `decimals` digits is a decimal comma
  // ("10,5"); any other comma groups thousands ("1,250").
  if (!text.includes(".")) {
    const commas = text.match(/,/g)?.length ?? 0;
    const tail = text.split(",").at(-1) ?? "";
    if (commas === 1 && tail.length > 0 && tail.length <= decimals) text = text.replace(",", ".");
  }
  text = text.replace(/,/g, "");

  const [int = "", ...rest] = text.split(".");
  const whole = int.replace(/^0+(?=\d)/, "").slice(0, maxIntegerDigits);
  if (rest.length === 0 || decimals === 0) return whole;
  return `${whole || "0"}.${rest.join("").slice(0, decimals)}`;
}

/** The canonical form for an intent: "010." -> "10", ".50" -> "0.5", "" -> "0". */
export function canonicalDecimal(value: string): string {
  const [int = "", fraction = ""] = value.split(".");
  const whole = int.replace(/^0+(?=\d)/, "") || "0";
  const decimals = fraction.replace(/0+$/, "");
  return decimals ? `${whole}.${decimals}` : whole;
}

/** Whether the text holds a number the user has actually entered. */
export const isEntered = (value: string) => value !== "" && Number(value) > 0;
