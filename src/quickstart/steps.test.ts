import { describe, expect, it } from "bun:test";
import { buildSteps } from "./steps.ts";
import type { QuickstartOptions, QuickstartStep } from "./types.ts";

describe("buildSteps", () => {
	it("returns an array of QuickstartStep", () => {
		const steps = buildSteps({});
		expect(Array.isArray(steps)).toBe(true);
		expect(steps.length).toBeGreaterThan(0);
	});

	it("every step has required string fields", () => {
		const steps = buildSteps({});
		for (const step of steps) {
			expect(typeof step.id).toBe("string");
			expect(step.id.length).toBeGreaterThan(0);
			expect(typeof step.title).toBe("string");
			expect(step.title.length).toBeGreaterThan(0);
			expect(typeof step.description).toBe("string");
		}
	});

	it("every step has callable check and run functions", () => {
		const steps = buildSteps({});
		for (const step of steps) {
			expect(typeof step.check).toBe("function");
			expect(typeof step.run).toBe("function");
		}
	});

	it("step IDs are unique", () => {
		const steps = buildSteps({});
		const ids = steps.map((s: QuickstartStep) => s.id);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});

	it("includes a prerequisites step", () => {
		const steps = buildSteps({});
		const prereqStep = steps.find((s: QuickstartStep) => s.id === "prerequisites");
		expect(prereqStep).toBeDefined();
	});

	it("prerequisites step is the first step", () => {
		const steps = buildSteps({});
		expect(steps[0]?.id).toBe("prerequisites");
	});

	it("accepts options without error", () => {
		const opts: QuickstartOptions = { yes: true, verbose: true, json: false };
		expect(() => buildSteps(opts)).not.toThrow();
	});

	it("returns same step count regardless of yes option", () => {
		const stepsDefault = buildSteps({});
		const stepsYes = buildSteps({ yes: true });
		expect(stepsYes.length).toBe(stepsDefault.length);
	});

	it("check() returns a valid StepStatus", async () => {
		const steps = buildSteps({});
		const validStatuses = new Set(["pending", "complete", "skipped", "failed"]);
		for (const step of steps) {
			const status = await step.check();
			expect(validStatuses.has(status)).toBe(true);
		}
	});

	it.skip("run() resolves without throwing — integration test, runs real subprocesses", async () => {
		// This test only verifies the interface contract — steps may succeed or fail
		// based on the local environment.
		const steps = buildSteps({ yes: true });
		for (const step of steps) {
			const result = await step.run().catch(() => null);
			if (result !== null) {
				expect(typeof result.status).toBe("string");
			}
		}
	}, 30_000);
});
