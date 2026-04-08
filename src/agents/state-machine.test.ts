import { describe, expect, test } from "bun:test";
import { isValidTransition, VALID_TRANSITIONS, validateTransition } from "./state-machine.ts";
import type { AgentState } from "./types.ts";

describe("VALID_TRANSITIONS", () => {
	test("covers all AgentState values", () => {
		const allStates: AgentState[] = [
			"booting",
			"working",
			"waiting",
			"completed",
			"stalled",
			"zombie",
		];
		for (const state of allStates) {
			expect(VALID_TRANSITIONS.has(state)).toBe(true);
		}
	});

	test("completed is terminal — no outgoing edges", () => {
		const completedEdges = VALID_TRANSITIONS.get("completed");
		expect(completedEdges).toBeDefined();
		expect(completedEdges?.size).toBe(0);
	});
});

describe("isValidTransition", () => {
	test("same state is always valid (no-op)", () => {
		const allStates: AgentState[] = [
			"booting",
			"working",
			"waiting",
			"completed",
			"stalled",
			"zombie",
		];
		for (const state of allStates) {
			expect(isValidTransition(state, state)).toBe(true);
		}
	});

	// booting edges
	test("booting → working", () => expect(isValidTransition("booting", "working")).toBe(true));
	test("booting → zombie", () => expect(isValidTransition("booting", "zombie")).toBe(true));
	test("booting → completed", () => expect(isValidTransition("booting", "completed")).toBe(true));
	test("booting → waiting (invalid)", () =>
		expect(isValidTransition("booting", "waiting")).toBe(false));
	test("booting → stalled (invalid)", () =>
		expect(isValidTransition("booting", "stalled")).toBe(false));

	// working edges
	test("working → waiting", () => expect(isValidTransition("working", "waiting")).toBe(true));
	test("working → stalled", () => expect(isValidTransition("working", "stalled")).toBe(true));
	test("working → completed", () => expect(isValidTransition("working", "completed")).toBe(true));
	test("working → zombie", () => expect(isValidTransition("working", "zombie")).toBe(true));
	test("working → booting (invalid)", () =>
		expect(isValidTransition("working", "booting")).toBe(false));

	// waiting edges
	test("waiting → working", () => expect(isValidTransition("waiting", "working")).toBe(true));
	test("waiting → booting", () => expect(isValidTransition("waiting", "booting")).toBe(true));
	test("waiting → zombie", () => expect(isValidTransition("waiting", "zombie")).toBe(true));
	test("waiting → completed", () => expect(isValidTransition("waiting", "completed")).toBe(true));
	test("waiting → stalled (invalid)", () =>
		expect(isValidTransition("waiting", "stalled")).toBe(false));

	// stalled edges
	test("stalled → working", () => expect(isValidTransition("stalled", "working")).toBe(true));
	test("stalled → zombie", () => expect(isValidTransition("stalled", "zombie")).toBe(true));
	test("stalled → completed", () => expect(isValidTransition("stalled", "completed")).toBe(true));
	test("stalled → booting (invalid)", () =>
		expect(isValidTransition("stalled", "booting")).toBe(false));
	test("stalled → waiting (invalid)", () =>
		expect(isValidTransition("stalled", "waiting")).toBe(false));

	// zombie edges
	test("zombie → booting", () => expect(isValidTransition("zombie", "booting")).toBe(true));
	test("zombie → completed", () => expect(isValidTransition("zombie", "completed")).toBe(true));
	test("zombie → working (invalid)", () =>
		expect(isValidTransition("zombie", "working")).toBe(false));
	test("zombie → waiting (invalid)", () =>
		expect(isValidTransition("zombie", "waiting")).toBe(false));
	test("zombie → stalled (invalid)", () =>
		expect(isValidTransition("zombie", "stalled")).toBe(false));

	// completed edges (none)
	test("completed → booting (invalid)", () =>
		expect(isValidTransition("completed", "booting")).toBe(false));
	test("completed → working (invalid)", () =>
		expect(isValidTransition("completed", "working")).toBe(false));
	test("completed → waiting (invalid)", () =>
		expect(isValidTransition("completed", "waiting")).toBe(false));
	test("completed → stalled (invalid)", () =>
		expect(isValidTransition("completed", "stalled")).toBe(false));
	test("completed → zombie (invalid)", () =>
		expect(isValidTransition("completed", "zombie")).toBe(false));
});

describe("validateTransition", () => {
	const ctx = { agentName: "test-agent", capability: "builder", reason: "test" };

	test("valid transition succeeds", () => {
		const result = validateTransition("working", "waiting", ctx);
		expect(result.success).toBe(true);
		expect(result.from).toBe("working");
		expect(result.to).toBe("waiting");
		expect(result.forced).toBe(false);
		expect(result.reason).toBe("test");
	});

	test("no-op transition succeeds", () => {
		const result = validateTransition("working", "working", ctx);
		expect(result.success).toBe(true);
		expect(result.forced).toBe(false);
		expect(result.reason).toBe("no-op");
	});

	test("invalid transition without force fails", () => {
		const result = validateTransition("zombie", "working", ctx);
		expect(result.success).toBe(false);
		expect(result.forced).toBe(false);
		expect(result.reason).toContain("Invalid transition zombie -> working");
	});

	test("invalid transition with force succeeds", () => {
		const result = validateTransition("zombie", "working", ctx, { force: true });
		expect(result.success).toBe(true);
		expect(result.forced).toBe(true);
		expect(result.reason).toContain("ZFC override");
	});

	test("completed → anything with force succeeds", () => {
		const result = validateTransition("completed", "booting", ctx, { force: true });
		expect(result.success).toBe(true);
		expect(result.forced).toBe(true);
	});

	test("completed → anything without force fails", () => {
		const result = validateTransition("completed", "booting", ctx);
		expect(result.success).toBe(false);
	});

	test("force flag is false for valid transitions", () => {
		const result = validateTransition("waiting", "working", ctx, { force: true });
		expect(result.success).toBe(true);
		// Valid transition — force not needed, forced should be false
		expect(result.forced).toBe(false);
	});

	test("preserves context in result", () => {
		const customCtx = { agentName: "my-builder", capability: "builder", reason: "review pass" };
		const result = validateTransition("working", "completed", customCtx);
		expect(result.reason).toBe("review pass");
	});
});
