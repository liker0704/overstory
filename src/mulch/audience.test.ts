import { describe, expect, test } from "bun:test";
import { capabilityToAudience } from "./audience.ts";

describe("capabilityToAudience", () => {
	test("maps builder to builder", () => {
		expect(capabilityToAudience("builder")).toBe("builder");
	});

	test("maps scout to scout", () => {
		expect(capabilityToAudience("scout")).toBe("scout");
	});

	test("maps reviewer to reviewer", () => {
		expect(capabilityToAudience("reviewer")).toBe("reviewer");
	});

	test("maps lead to lead", () => {
		expect(capabilityToAudience("lead")).toBe("lead");
	});

	test("maps lead-mission to lead", () => {
		expect(capabilityToAudience("lead-mission")).toBe("lead");
	});

	test("maps coordinator to coordinator", () => {
		expect(capabilityToAudience("coordinator")).toBe("coordinator");
	});

	test("maps coordinator-mission to coordinator", () => {
		expect(capabilityToAudience("coordinator-mission")).toBe("coordinator");
	});

	test("maps merger to merger", () => {
		expect(capabilityToAudience("merger")).toBe("merger");
	});

	test("maps architect to architect", () => {
		expect(capabilityToAudience("architect")).toBe("architect");
	});

	test("maps tester to tester", () => {
		expect(capabilityToAudience("tester")).toBe("tester");
	});

	test("maps mission-analyst to analyst", () => {
		expect(capabilityToAudience("mission-analyst")).toBe("analyst");
	});

	test("maps execution-director to coordinator", () => {
		expect(capabilityToAudience("execution-director")).toBe("coordinator");
	});

	test("maps monitor to all", () => {
		expect(capabilityToAudience("monitor")).toBe("all");
	});

	test("maps research-lead to all", () => {
		expect(capabilityToAudience("research-lead")).toBe("all");
	});

	test("maps researcher to all", () => {
		expect(capabilityToAudience("researcher")).toBe("all");
	});

	test("maps plan-* prefix to architect", () => {
		expect(capabilityToAudience("plan-review-lead")).toBe("architect");
		expect(capabilityToAudience("plan-devil-advocate")).toBe("architect");
		expect(capabilityToAudience("plan-anything")).toBe("architect");
	});

	test("returns undefined for unknown capability", () => {
		expect(capabilityToAudience("unknown-role")).toBeUndefined();
		expect(capabilityToAudience("")).toBeUndefined();
		expect(capabilityToAudience("random")).toBeUndefined();
	});
});
