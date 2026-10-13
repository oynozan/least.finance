import { expect, test } from "@playwright/test";
import {
    initialState,
    reduce,
    resolve,
    schema,
    VERB,
    type ChoiceSlotView,
    type Choice,
    type SentenceState,
    type SlotSpec,
    type SlotView,
} from "@/lib/sentence";

type Terms = { coin: string; net: string; amount: string };
type Ctx = { blocked: readonly string[]; seen: Record<string, string>[] };
type Values = Readonly<Terms>;
type Spec = SlotSpec<Values, Ctx, string, keyof Terms & string>;

const NETS: Record<string, readonly string[]> = { ETH: ["base", "arb"], SOL: ["sol"], USDC: ["base", "arb", "sol"] };
const COINS = ["ETH", "SOL", "USDC"];
const MISSING = { message: "Pick a network.", cta: "Pick a network" };
const HOLD_NETS = ["base", "sol"];

// The arb network has no icon, so a badge from it can't be drawn
function netChoices(values: Values, ctx: Ctx, only?: readonly string[]): Choice[] {
    ctx.seen.push({ ...values });
    return (NETS[values.coin] ?? [])
        .filter((id) => !only || only.includes(id))
        .map((id) => ({
            value: id,
            label: id.toUpperCase(),
            icon: id === "arb" ? undefined : { set: "net", id },
            disabled: ctx.blocked.includes(id) ? "Nothing here" : undefined,
        }));
}

function slots(withThen: boolean, only?: readonly string[]): Record<keyof Terms, Spec> {
    return {
        coin: {
            kind: "choice",
            hint: "Coin you pay with",
            missing: { message: "Pick a coin.", cta: "Pick a coin" },
            term: "coin",
            then: withThen ? "net" : undefined,
            choices: () => COINS.map((c) => ({ value: c, label: c, icon: { set: "coin", id: c } })),
        },
        net: {
            kind: "choice",
            prompt: "Which network?",
            hint: "Network of the coin",
            missing: MISSING,
            term: "net",
            choices: (values, ctx) => netChoices(values, ctx, only),
        },
        amount: {
            kind: "number",
            hint: "Amount",
            missing: { message: "Enter an amount.", cta: "Enter an amount" },
            term: "amount",
            prompt: "How much?",
            decimals: 2,
            placeholder: "0",
        },
    };
}

const { operation, registry } = schema<Terms, Ctx>();

const template = () => [VERB, "my", { slot: "coin" }, "for", { slot: "amount" }, "USD."] as const;
const preview = () => ({ rows: [] });

// Two operations over the same terms, the second offering fewer networks per coin
function build(withThen = true, normalize = false) {
    const move = operation({
        id: "move",
        verbs: [{ id: "move", label: "Move", hint: "Move it", group: "Trade", fixed: {}, cta: () => "Review move" }],
        slots: slots(withThen),
        defaults: () => ({ coin: "ETH", net: "base", amount: "10" }),
        template,
        toIntent: (v) => ({ type: "move", ...v }),
        preview,
    });
    const hold = operation({
        id: "hold",
        verbs: [{ id: "hold", label: "Hold", hint: "Hold it", group: "Trade", fixed: {}, cta: () => "Review hold" }],
        slots: slots(withThen, HOLD_NETS),
        defaults: () => ({ coin: "SOL", net: "sol", amount: "10" }),
        template,
        normalize: normalize
            ? (next, _cause, _fixed, ctx) => {
                  const offered = netChoices(next, ctx, HOLD_NETS);
                  return offered.some((c) => c.value === next.net) ? next : { ...next, net: offered[0]?.value ?? "" };
              }
            : undefined,
        toIntent: (v) => ({ type: "hold", ...v }),
        preview,
    });
    return registry([move, hold], { lead: "I want to" });
}

const ctx = (blocked: readonly string[] = []): Ctx => ({ blocked, seen: [] });

const withDraft =
    (patch: Record<string, string>) =>
    (s: SentenceState<Terms>): SentenceState<Terms> => ({
        ...s,
        drafts: { ...s.drafts, move: { ...s.drafts.move, ...patch } },
    });

function view(c = ctx(), edit?: (s: SentenceState<Terms>) => SentenceState<Terms>, reg = build()) {
    const state = initialState(reg, "move", c);
    return resolve(reg, edit ? edit(state) : state, c);
}

function choiceSlot(slot: SlotView): ChoiceSlotView {
    if (slot.kind !== "choice") throw new Error("not a choice slot");
    return slot;
}

test.describe("companion slots", () => {
    test("a companion's view comes with its host", () => {
        const v = view();
        const host = choiceSlot(v.slots.coin);
        expect(host.then).toMatchObject({
            id: "net",
            prompt: "Which network?",
            hint: "Network of the coin",
            value: "base",
            selected: { value: "base", label: "BASE" },
        });
        expect(host.then?.choicesFor("ETH").map((c) => c.value)).toEqual(["base", "arb"]);
        // The companion is no slot of the sentence, and a slot without one carries none
        expect(v.slots.net).toBeUndefined();
        expect(v.slots.amount).not.toHaveProperty("then");
        expect(choiceSlot(view(ctx(), undefined, build(false)).slots.coin).then).toBeUndefined();
    });

    test("choicesFor answers for any host value", () => {
        const c = ctx();
        const host = choiceSlot(view(c).slots.coin);
        c.seen.length = 0;
        expect(host.then?.choicesFor("SOL").map((x) => x.value)).toEqual(["sol"]);
        expect(host.then?.choicesFor("USDC").map((x) => x.value)).toEqual(["base", "arb", "sol"]);
        expect(host.then?.choicesFor("DOGE")).toEqual([]);
        // Only the host's value is swapped, every other value is the current one
        expect(c.seen).toEqual([
            { coin: "SOL", net: "base", amount: "10" },
            { coin: "USDC", net: "base", amount: "10" },
            { coin: "DOGE", net: "base", amount: "10" },
        ]);
        expect(host.then?.value).toBe("base");
        expect(host.value).toBe("ETH");
    });

    test("a missing companion is the host's issue", () => {
        const expected = { code: "missing", severity: "incomplete", slot: "coin", ...MISSING };

        const notOffered = view(ctx(), withDraft({ net: "sol" }));
        expect(notOffered.slots.coin.issue).toEqual(expected);
        expect(notOffered.blocking).toEqual(expected);
        expect(notOffered.intent).toBeNull();

        const empty = view(ctx(), withDraft({ net: "" }));
        expect(empty.slots.coin.issue).toEqual(expected);

        const disabled = view(ctx(["base"]));
        expect(disabled.slots.coin.issue).toEqual(expected);
        expect(disabled.issues).toEqual([expected]);
        expect(disabled.intent).toBeNull();

        const fine = view();
        expect(fine.slots.coin.issue).toBeUndefined();
        expect(fine.blocking).toBeUndefined();
        expect(fine.intent).not.toBeNull();
    });

    test("an unusable host keeps its own issue and adds none for the companion", () => {
        const gone = view(ctx(), withDraft({ coin: "DOGE", net: "sol" }));
        expect(gone.issues).toEqual([
            { code: "missing", severity: "incomplete", slot: "coin", message: "Pick a coin.", cta: "Pick a coin" },
        ]);
    });

    test("the companion's icon badges the selected host, not the list", () => {
        const host = choiceSlot(view().slots.coin);
        expect(host.selected?.icon).toEqual({ set: "coin", id: "ETH", badge: { set: "net", id: "base" } });
        expect(host.selected?.label).toBe("ETH");
        expect(host.choices.map((c) => c.icon)).toEqual(COINS.map((id) => ({ set: "coin", id })));
        expect(host.then?.selected?.icon).toEqual({ set: "net", id: "base" });

        const bare = choiceSlot(view(ctx(), withDraft({ net: "arb" })).slots.coin);
        expect(bare.selected?.icon).toEqual({ set: "coin", id: "ETH" });
    });

    test("companions add no parts and no text", () => {
        for (const patch of [{}, { net: "arb" }, { net: "sol" }] as Record<string, string>[]) {
            const a = view(ctx(), withDraft(patch), build(true));
            const b = view(ctx(), withDraft(patch), build(false));
            expect(a.parts).toEqual(b.parts);
            expect(a.text).toBe(b.text);
        }
        const v = view();
        expect(v.text).toBe("I want to Move my ETH for 10 USD.");
        expect(v.parts.map((p) => p.key)).toEqual([
            "w:i:0",
            "w:want:0",
            "w:to:0",
            "verb",
            "w:my:0",
            "term:coin",
            "w:for:0",
            "term:amount",
            "w:usd:0",
        ]);
    });

    test("a carried companion term the new host value rejects is left to normalize", () => {
        const c = ctx();
        const carry = (reg: ReturnType<typeof build>) => {
            let state = initialState(reg, "move", c);
            state = reduce(reg, state, { type: "slot", slot: "net", value: "arb" }, c);
            state = reduce(reg, state, { type: "verb", verbId: "hold" }, c);
            return { state, view: resolve(reg, state, c) };
        };

        // Hold takes ETH but not on Arbitrum, so the engine keeps Hold's own draft and the host reports it
        const plain = carry(build(true, false));
        expect(plain.state.drafts.hold).toEqual({ coin: "ETH", net: "sol", amount: "10" });
        expect(plain.view.slots.coin.issue).toMatchObject({ slot: "coin", ...MISSING });
        expect(choiceSlot(plain.view.slots.coin).then?.selected).toBeUndefined();

        // The operation's normalize puts a network that fits in its place
        const settled = carry(build(true, true));
        expect(settled.state.drafts.hold).toEqual({ coin: "ETH", net: "base", amount: "10" });
        expect(settled.view.slots.coin.issue).toBeUndefined();
        expect(choiceSlot(settled.view.slots.coin).then?.value).toBe("base");
    });

    test("registry rejects a bad then", () => {
        const make = (patch: Record<string, Record<string, unknown>>) => {
            const base: Record<string, Spec> = slots(true);
            const merged = { ...base };
            for (const [id, fields] of Object.entries(patch))
                merged[id] = { ...(base[id] ?? base.net), ...fields } as Spec;
            return operation({
                id: "bad",
                verbs: [{ id: "bad", label: "Bad", hint: "", group: "Trade", fixed: {}, cta: () => "Review" }],
                slots: merged as Record<keyof Terms, Spec>,
                defaults: () => ({ coin: "ETH", net: "base", amount: "10" }),
                template,
                toIntent: () => null,
                preview,
            });
        };
        const lead = { lead: "" };

        // The controls are good, so each failure below comes from its then alone
        expect(() => registry([make({})], lead)).not.toThrow();
        expect(() => registry([make({ extra: { term: undefined } })], lead)).not.toThrow();
        expect(() => registry([make({ other: { term: undefined } })], lead)).not.toThrow();

        // A slot that doesn't exist
        expect(() => registry([make({ coin: { then: "nowhere" } })], lead)).toThrow(/then/);
        // A number slot
        expect(() => registry([make({ coin: { then: "amount" } })], lead)).toThrow(/then/);
        // The host itself, which has a then of its own
        expect(() => registry([make({ coin: { then: "coin" } })], lead)).toThrow(/then/);
        // A slot with a then of its own
        expect(() => registry([make({ net: { then: "extra" }, extra: { term: undefined } })], lead)).toThrow(/then/);
        // A slot another host already has
        expect(() => registry([make({ other: { term: undefined, then: "net" } })], lead)).toThrow(/then/);
    });
});

test.describe("what the person chose", () => {
    test("a slot action records its slot and term, and nothing else does", () => {
        const c = ctx();
        const reg = build(true, true);
        const start = initialState(reg, "move", c);
        expect(start.chosen).toEqual({ slots: {}, terms: [] });

        const picked = reduce(reg, start, { type: "slot", slot: "coin", value: "USDC" }, c);
        expect(picked.chosen).toEqual({ slots: { move: ["coin"] }, terms: ["coin"] });
        // A verb change, even one that normalizes, adds nothing
        const moved = reduce(reg, picked, { type: "verb", verbId: "hold" }, c);
        expect(moved.chosen).toBe(picked.chosen);
        // A rejected action adds nothing; an accepted one adds its slot once
        expect(reduce(reg, picked, { type: "slot", slot: "coin", value: "DOGE" }, c)).toBe(picked);
        const again = reduce(reg, moved, { type: "slot", slot: "coin", value: "SOL" }, c);
        expect(again.chosen).toEqual({ slots: { move: ["coin"], hold: ["coin"] }, terms: ["coin"] });
        const more = reduce(reg, again, { type: "slot", slot: "amount", value: "25" }, c);
        expect(more.chosen.terms).toEqual(["coin", "amount"]);
        expect(reduce(reg, more, { type: "slot", slot: "amount", value: "30" }, c).chosen.slots).toEqual({
            move: ["coin"],
            hold: ["coin", "amount"],
        });
    });

    test("a value the slot already holds is still a choice", () => {
        const c = ctx();
        const reg = build(true, true);
        const start = initialState(reg, "move", c);
        const same = reduce(reg, start, { type: "slot", slot: "coin", value: "ETH" }, c);
        expect(same.chosen).toEqual({ slots: { move: ["coin"] }, terms: ["coin"] });
        expect(same.drafts).toBe(start.drafts);
        expect(reduce(reg, same, { type: "slot", slot: "coin", value: "ETH" }, c)).toBe(same);
    });
});
