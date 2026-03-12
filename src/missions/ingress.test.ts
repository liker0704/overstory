/**
 * Tests for mission ingress validation (validateMissionIngress).
 */

import { describe, expect, test } from "bun:test";
import type { MissionFindingPayload } from "../types.ts";
import { INGRESS_CATEGORIES, validateMissionIngress } from "./ingress.ts";

function makePayload(overrides: Partial<MissionFindingPayload> = {}): MissionFindingPayload {
	return {
		workstreamId: "ws-001",
		category: "cross-stream",
		summary: "A finding",
		affectedWorkstreams: ["ws-001", "ws-002"],
		...overrides,
	};
}

// === INGRESS_CATEGORIES ===

describe("INGRESS_CATEGORIES", () => {
	test("contains all four qualifying categories", () => {
		expect(INGRESS_CATEGORIES).toContain("cross-stream");
		expect(INGRESS_CATEGORIES).toContain("brief-invalidating");
		expect(INGRESS_CATEGORIES).toContain("shared-assumption-changing");
		expect(INGRESS_CATEGORIES).toContain("accepted-semantics-risk");
		expect(INGRESS_CATEGORIES).toHaveLength(4);
	});
});

// === validateMissionIngress ===

describe("validateMissionIngress", () => {
	describe("cross-stream", () => {
		test("valid when affectedWorkstreams.length > 1", () => {
			const result = validateMissionIngress(
				makePayload({ category: "cross-stream", affectedWorkstreams: ["ws-1", "ws-2"] }),
			);
			expect(result.valid).toBe(true);
			expect(result.category).toBe("cross-stream");
		});

		test("valid with three or more affected workstreams", () => {
			const result = validateMissionIngress(
				makePayload({ category: "cross-stream", affectedWorkstreams: ["ws-1", "ws-2", "ws-3"] }),
			);
			expect(result.valid).toBe(true);
			expect(result.category).toBe("cross-stream");
		});

		test("invalid when affectedWorkstreams.length === 1", () => {
			const result = validateMissionIngress(
				makePayload({ category: "cross-stream", affectedWorkstreams: ["ws-only"] }),
			);
			expect(result.valid).toBe(false);
			expect(result.category).toBeNull();
			expect(result.reason).toMatch(/affectedWorkstreams/);
		});

		test("invalid when affectedWorkstreams is empty", () => {
			const result = validateMissionIngress(
				makePayload({ category: "cross-stream", affectedWorkstreams: [] }),
			);
			expect(result.valid).toBe(false);
			expect(result.category).toBeNull();
		});
	});

	describe("brief-invalidating", () => {
		test("valid regardless of affectedWorkstreams count", () => {
			const result = validateMissionIngress(
				makePayload({ category: "brief-invalidating", affectedWorkstreams: ["ws-1"] }),
			);
			expect(result.valid).toBe(true);
			expect(result.category).toBe("brief-invalidating");
		});

		test("returns category in result", () => {
			const result = validateMissionIngress(makePayload({ category: "brief-invalidating" }));
			expect(result.category).toBe("brief-invalidating");
		});
	});

	describe("shared-assumption-changing", () => {
		test("valid (trust sender's classification)", () => {
			const result = validateMissionIngress(
				makePayload({ category: "shared-assumption-changing" }),
			);
			expect(result.valid).toBe(true);
			expect(result.category).toBe("shared-assumption-changing");
		});
	});

	describe("accepted-semantics-risk", () => {
		test("valid (trust sender's classification)", () => {
			const result = validateMissionIngress(makePayload({ category: "accepted-semantics-risk" }));
			expect(result.valid).toBe(true);
			expect(result.category).toBe("accepted-semantics-risk");
		});
	});

	describe("non-qualifying findings", () => {
		test("unknown category returns valid=false with reason", () => {
			const result = validateMissionIngress(
				// biome-ignore lint/suspicious/noExplicitAny: intentional invalid category for test
				makePayload({ category: "unknown-category" as any }),
			);
			expect(result.valid).toBe(false);
			expect(result.category).toBeNull();
			expect(result.reason).toMatch(/lead level/);
		});

		test("reason explains the finding should stay at lead level", () => {
			const result = validateMissionIngress(
				makePayload({ category: "cross-stream", affectedWorkstreams: ["ws-only"] }),
			);
			expect(result.reason).toMatch(/lead level/);
		});
	});
});
