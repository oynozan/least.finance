import type { Choice } from "./types";

/** The choices a typed search leaves: those whose label starts with it first, then those with it anywhere in the label or description. */
export function filterChoices<T extends string>(choices: readonly Choice<T>[], query: string): readonly Choice<T>[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return choices;
    const starts: Choice<T>[] = [];
    const within: Choice<T>[] = [];
    for (const choice of choices) {
        if (choice.label.toLowerCase().startsWith(needle)) starts.push(choice);
        else if (`${choice.label} ${choice.description ?? ""}`.toLowerCase().includes(needle)) within.push(choice);
    }
    return [...starts, ...within];
}
