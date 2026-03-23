import { describe, expect, it } from "bun:test";
import { analyzeCompatibility } from "./analyzer.ts";
import { formatCompatReport } from "./report.ts";
import type { ExportedSymbol, TypeSurface } from "./types.ts";

function makeSurface(ref: string, symbols: ExportedSymbol[]): TypeSurface {
	return { ref, symbols, extractedAt: new Date().toISOString() };
}

function makeSym(overrides: Partial<ExportedSymbol> & { name: string }): ExportedSymbol {
	return { kind: "interface", signature: "Foo", filePath: "src/foo.ts", line: 1, ...overrides };
}

describe("analyzeCompatibility", () => {
	it("1. identical surfaces → compatible, no changes", async () => {
		const sym = makeSym({ name: "Foo", signature: "{ a: string }" });
		const a = makeSurface("main", [sym]);
		const b = makeSurface("feature", [sym]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(true);
		expect(result.changes).toHaveLength(0);
		expect(result.staticOnly).toBe(true);
	});

	it("2. surface B removes an exported interface → incompatible, breaking", async () => {
		const sym = makeSym({ name: "Foo", kind: "interface" });
		const a = makeSurface("main", [sym]);
		const b = makeSurface("feature", []);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(false);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.severity).toBe("breaking");
		expect(result.changes[0]?.kind).toBe("removed");
	});

	it("3. surface B adds a new export → compatible, info change", async () => {
		const sym = makeSym({ name: "Foo" });
		const newSym = makeSym({ name: "Bar", filePath: "src/bar.ts" });
		const a = makeSurface("main", [sym]);
		const b = makeSurface("feature", [sym, newSym]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(true);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.severity).toBe("info");
		expect(result.changes[0]?.kind).toBe("added");
	});

	it("4. surface B modifies interface (adds optional prop) → compatible, warning", async () => {
		const symA = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string }",
		});
		const symB = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string; b?: number }",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(true);
		expect(result.changes).toHaveLength(1);
		expect(result.changes[0]?.severity).toBe("warning");
	});

	it("5. surface B modifies interface (removes prop) → incompatible, breaking", async () => {
		const symA = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string; b: number }",
		});
		const symB = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string }",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.compatible).toBe(false);
		expect(result.changes[0]?.severity).toBe("breaking");
	});

	it("6. both surfaces have same const with different values → warning", async () => {
		const symA = makeSym({
			name: "VERSION",
			kind: "const",
			signature: '"1.0.0"',
			filePath: "src/version.ts",
		});
		const symB = makeSym({
			name: "VERSION",
			kind: "const",
			signature: '"2.0.0"',
			filePath: "src/version.ts",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.changes[0]?.severity).toBe("warning");
	});

	it("7. schema conflict: both modify same const in types.ts → breaking", async () => {
		const symA = makeSym({
			name: "RUN_STATES",
			kind: "const",
			signature: '["active", "stopped"]',
			filePath: "src/runs/types.ts",
		});
		const symB = makeSym({
			name: "RUN_STATES",
			kind: "const",
			signature: '["active", "stopped", "paused"]',
			filePath: "src/runs/types.ts",
		});
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB]);
		const result = await analyzeCompatibility(a, b);
		expect(result.changes[0]?.severity).toBe("breaking");
		expect(result.compatible).toBe(false);
	});

	it("8. AI fallback triggers when warnings exceed threshold", async () => {
		// Create 6 warning-level changes (aiThreshold default is 5)
		const symbols: ExportedSymbol[] = Array.from({ length: 6 }, (_, i) =>
			makeSym({ name: `Sym${i}`, kind: "const", signature: `"v${i}"`, filePath: "src/foo.ts" }),
		);
		const symbolsB: ExportedSymbol[] = Array.from({ length: 6 }, (_, i) =>
			makeSym({ name: `Sym${i}`, kind: "const", signature: `"v${i}_new"`, filePath: "src/foo.ts" }),
		);
		const a = makeSurface("main", symbols);
		const b = makeSurface("feature", symbolsB);

		let aiCalled = false;
		const result = await analyzeCompatibility(a, b, undefined, {
			invoke: async () => {
				aiCalled = true;
				return "AI enriched summary.";
			},
		});
		expect(aiCalled).toBe(true);
		expect(result.staticOnly).toBe(false);
		expect(result.summary).toBe("AI enriched summary.");
	});

	it("9. AI failure is non-blocking", async () => {
		const symbols: ExportedSymbol[] = Array.from({ length: 6 }, (_, i) =>
			makeSym({ name: `X${i}`, kind: "const", signature: `"a${i}"`, filePath: "src/foo.ts" }),
		);
		const symbolsB: ExportedSymbol[] = Array.from({ length: 6 }, (_, i) =>
			makeSym({ name: `X${i}`, kind: "const", signature: `"b${i}"`, filePath: "src/foo.ts" }),
		);
		const a = makeSurface("main", symbols);
		const b = makeSurface("feature", symbolsB);

		const result = await analyzeCompatibility(a, b, undefined, {
			invoke: async () => {
				throw new Error("AI error");
			},
		});
		expect(result.staticOnly).toBe(true);
		expect(result.summary).toBeTruthy();
	});
});

describe("formatCompatReport", () => {
	it("10. report formatting produces valid markdown", async () => {
		const symA = makeSym({ name: "Foo", kind: "interface", signature: "{ a: string }" });
		const symB = makeSym({
			name: "Foo",
			kind: "interface",
			signature: "{ a: string; b?: number }",
		});
		const symNew = makeSym({ name: "Bar", filePath: "src/bar.ts" });
		const a = makeSurface("main", [symA]);
		const b = makeSurface("feature", [symB, symNew]);
		const result = await analyzeCompatibility(a, b);
		const report = formatCompatReport(result);

		expect(report).toContain("# Compatibility Report");
		expect(report).toContain("**Branch A:** main");
		expect(report).toContain("**Branch B:** feature");
		expect(report).toContain("Compatible");
		expect(report).toContain("## Summary");
		// Table headers
		expect(report).toContain("| Symbol |");
		expect(report).toContain("| Severity |");
		// Change rows
		expect(report).toContain("Foo");
		expect(report).toContain("Bar");
	});
});
