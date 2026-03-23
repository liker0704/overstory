import { describe, expect, test } from "bun:test";
import { renderContext } from "./render.ts";
import type { ProjectContext } from "./types.ts";

function makeContext(overrides?: Partial<ProjectContext["signals"]>): ProjectContext {
	return {
		version: 1,
		generatedAt: "2024-01-01T00:00:00.000Z",
		structuralHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
		signals: {
			languages: [{ language: "TypeScript", framework: "bun", configFile: "package.json" }],
			directoryProfile: {
				sourceRoots: ["src"],
				testRoots: ["src"],
				zones: [{ path: ".github", category: "ci" }],
			},
			namingVocabulary: {
				commonPrefixes: ["create", "get"],
				conventions: [{ pattern: "camelCase", description: "functions use camelCase" }],
			},
			testConventions: {
				framework: "bun",
				filePattern: "*.test.ts",
				testRoots: ["src"],
				setupFiles: [],
			},
			errorPatterns: {
				baseClass: "OverstoryError",
				throwStyle: "new CustomError",
				patterns: ["OverstoryError"],
			},
			importHotspots: [
				{ module: "bun:sqlite", importCount: 20 },
				{ module: "chalk", importCount: 15 },
				{ module: "commander", importCount: 10 },
				{ module: "node:fs/promises", importCount: 8 },
				{ module: "node:path", importCount: 6 },
				{ module: "node:os", importCount: 4 },
			],
			configZones: [{ path: ".github", category: "ci" }],
			sharedInvariants: [
				{ type: "linter", description: "biome enforces formatting", source: "biome.json" },
				{ type: "typecheck", description: "strict mode enabled", source: "tsconfig.json" },
			],
			...overrides,
		},
	};
}

function emptyContext(): ProjectContext {
	return {
		version: 1,
		generatedAt: "2024-01-01T00:00:00.000Z",
		structuralHash: "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
		signals: {
			languages: [],
			directoryProfile: { sourceRoots: [], testRoots: [], zones: [] },
			namingVocabulary: { commonPrefixes: [], conventions: [] },
			testConventions: { framework: "", filePattern: "", testRoots: [], setupFiles: [] },
			errorPatterns: { throwStyle: "unknown", patterns: [] },
			importHotspots: [],
			configZones: [],
			sharedInvariants: [],
		},
	};
}

describe("renderContext compact mode (default)", () => {
	test("produces markdown with ## Project Context heading", () => {
		const output = renderContext(makeContext());
		expect(output).toContain("## Project Context");
	});

	test("output is < 2KB for typical input", () => {
		const output = renderContext(makeContext());
		expect(new TextEncoder().encode(output).length).toBeLessThan(2048);
	});

	test("is compact mode by default (no subsection headings)", () => {
		const output = renderContext(makeContext());
		expect(output).not.toContain("### Languages");
		expect(output).not.toContain("### Import Hotspots");
	});

	test("includes language names", () => {
		const output = renderContext(makeContext());
		expect(output).toContain("TypeScript");
	});

	test("includes top 5 import hotspots only", () => {
		const output = renderContext(makeContext());
		expect(output).toContain("bun:sqlite");
		// 6th hotspot should not appear
		expect(output).not.toContain("node:os");
	});

	test("includes invariants summary", () => {
		const output = renderContext(makeContext());
		expect(output).toContain("linter");
	});

	test("compact: true explicitly is same as default", () => {
		const dflt = renderContext(makeContext());
		const explicit = renderContext(makeContext(), { compact: true });
		expect(dflt).toBe(explicit);
	});
});

describe("renderContext full mode", () => {
	test("includes all signal section headings", () => {
		const output = renderContext(makeContext(), { compact: false });
		expect(output).toContain("### Languages");
		expect(output).toContain("### Directory Profile");
		expect(output).toContain("### Naming Vocabulary");
		expect(output).toContain("### Test Conventions");
		expect(output).toContain("### Error Patterns");
		expect(output).toContain("### Import Hotspots");
		expect(output).toContain("### Config Zones");
		expect(output).toContain("### Shared Invariants");
	});

	test("includes generatedAt timestamp", () => {
		const output = renderContext(makeContext(), { compact: false });
		expect(output).toContain("2024-01-01T00:00:00.000Z");
	});

	test("includes all import hotspots (not capped at 5)", () => {
		const output = renderContext(makeContext(), { compact: false });
		expect(output).toContain("node:os");
	});
});

describe("renderContext edge cases", () => {
	test("handles empty/default signals without throwing", () => {
		const output = renderContext(emptyContext());
		expect(output).toContain("## Project Context");
	});

	test("full mode with empty signals shows none-detected placeholders", () => {
		const output = renderContext(emptyContext(), { compact: false });
		expect(output).toContain("_none detected_");
	});

	test("compact mode with empty signals produces minimal output", () => {
		const output = renderContext(emptyContext());
		expect(output).toContain("## Project Context");
		// No bullets since everything is empty
		expect(output).not.toContain("**Languages:**");
	});
});
