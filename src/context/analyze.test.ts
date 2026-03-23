import { describe, expect, test } from "bun:test";

import { analyzeProject } from "./analyze.ts";

// Use the canonical overstory repo as a real test fixture
const OVERSTORY_ROOT = "/home/liker2/projects/os-eco/overstory";

describe("analyzeProject", () => {
	test("returns valid ProjectContext shape", async () => {
		const ctx = await analyzeProject(OVERSTORY_ROOT);
		expect(ctx.version).toBe(1);
		expect(typeof ctx.generatedAt).toBe("string");
		expect(new Date(ctx.generatedAt).getTime()).toBeGreaterThan(0);
		expect(typeof ctx.structuralHash).toBe("string");
		expect(ctx.structuralHash).toHaveLength(64);
		expect(ctx.signals).toBeDefined();
		expect(Array.isArray(ctx.signals.languages)).toBe(true);
		expect(Array.isArray(ctx.signals.importHotspots)).toBe(true);
		expect(Array.isArray(ctx.signals.configZones)).toBe(true);
		expect(Array.isArray(ctx.signals.sharedInvariants)).toBe(true);
	});

	test("respects disabledSignals — disabled signals are empty/default", async () => {
		const ctx = await analyzeProject(OVERSTORY_ROOT, {
			disabledSignals: ["languages", "importHotspots"],
		});
		expect(ctx.signals.languages).toEqual([]);
		expect(ctx.signals.importHotspots).toEqual([]);
		// Non-disabled signals are still populated
		expect(ctx.signals.directoryProfile).toBeDefined();
		expect(ctx.signals.testConventions).toBeDefined();
	});

	test("completes in < 5s", async () => {
		const start = Date.now();
		await analyzeProject(OVERSTORY_ROOT);
		expect(Date.now() - start).toBeLessThan(5000);
	}, 6000);

	test("structuralHash is deterministic for same inputs", async () => {
		const ctx1 = await analyzeProject(OVERSTORY_ROOT);
		const ctx2 = await analyzeProject(OVERSTORY_ROOT);
		expect(ctx1.structuralHash).toBe(ctx2.structuralHash);
	});

	test("disabling all signals still returns valid context", async () => {
		const ctx = await analyzeProject(OVERSTORY_ROOT, {
			disabledSignals: [
				"languages",
				"directoryProfile",
				"namingVocabulary",
				"testConventions",
				"errorPatterns",
				"importHotspots",
				"configZones",
				"sharedInvariants",
			],
		});
		expect(ctx.version).toBe(1);
		expect(ctx.structuralHash).toHaveLength(64);
		expect(ctx.signals.languages).toEqual([]);
	});
});
