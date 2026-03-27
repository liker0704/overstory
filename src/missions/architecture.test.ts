import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ArchitectureParseError,
	loadArchitecture,
	parseArchitecture,
	validateArchitecture,
} from "./architecture.ts";

const BACKTICK = "`";
const FENCE = BACKTICK + BACKTICK + BACKTICK;

const FULL_ARCH = `
## Context

This is the context for the architecture.

## Components

| Action | File | Purpose | Workstream |
|--------|------|---------|------------|
| CREATE | ${BACKTICK}src/foo.ts${BACKTICK} | Main module | ws-1 |
| MODIFY | src/bar.ts | Helper | ws-2 |

## Interfaces

### FooInterface (ws-1)
**Confidence:** High
${FENCE}typescript
export function foo(): string;
${FENCE}
**Behavior:** Returns a string
**Invariants:**
- Must return non-empty string
**Error cases:**
- Throws if input invalid

### ws-2
**Behavior:** Some behavior
**Invariants:**
- Invariant A
**Error cases:**
- Error A

## TDD Assignments

| Workstream | TDD Mode | Rationale |
|------------|----------|-----------|
| ws-1 | full | Critical path |
| ws-2 | light | Low risk |

## Key Decisions

### D-1: Use TypeScript
**Chosen:** TypeScript with strict mode
**Confidence:** High
**Rejected:**
- JavaScript \u2014 less type safety
- Flow - different ecosystem

## Constraints

### Boundaries
- Only modify src/
- No external deps

### Patterns
- Use dependency injection

### Prohibitions
- No global state
`;

describe("parseArchitecture", () => {
	test("full valid parse", () => {
		const arch = parseArchitecture(FULL_ARCH);

		expect(arch.context).toBe("This is the context for the architecture.");

		expect(arch.components).toHaveLength(2);
		expect(arch.components[0]).toEqual({
			action: "CREATE",
			file: "src/foo.ts",
			purpose: "Main module",
			workstream: "ws-1",
		});
		expect(arch.components[1]).toEqual({
			action: "MODIFY",
			file: "src/bar.ts",
			purpose: "Helper",
			workstream: "ws-2",
		});

		expect(arch.interfaces).toHaveLength(2);
		const iface = arch.interfaces[0];
		expect(iface?.name).toBe("FooInterface");
		expect(iface?.workstream).toBe("ws-1");
		expect(iface?.confidence).toBe("High");
		expect(iface?.signatures).toContain("export function foo(): string;");
		expect(iface?.behavior).toBe("Returns a string");
		expect(iface?.invariants).toEqual(["Must return non-empty string"]);
		expect(iface?.errorCases).toEqual(["Throws if input invalid"]);

		expect(arch.tddAssignments).toHaveLength(2);
		expect(arch.tddAssignments[0]).toEqual({
			workstreamId: "ws-1",
			tddMode: "full",
			rationale: "Critical path",
		});
		expect(arch.tddAssignments[1]).toEqual({
			workstreamId: "ws-2",
			tddMode: "light",
			rationale: "Low risk",
		});

		expect(arch.decisions).toHaveLength(1);
		const dec = arch.decisions[0];
		expect(dec?.id).toBe("D-1");
		expect(dec?.chosen).toBe("TypeScript with strict mode");
		expect(dec?.confidence).toBe("High");
		expect(dec?.rejected).toHaveLength(2);
		expect(dec?.rejected[0]).toEqual({ option: "JavaScript", reason: "less type safety" });
		expect(dec?.rejected[1]).toEqual({ option: "Flow", reason: "different ecosystem" });

		expect(arch.constraints.boundaries).toEqual(["Only modify src/", "No external deps"]);
		expect(arch.constraints.patterns).toEqual(["Use dependency injection"]);
		expect(arch.constraints.prohibitions).toEqual(["No global state"]);
	});

	test("missing sections return defaults", () => {
		const arch = parseArchitecture("## Context\n\nSome context");

		expect(arch.context).toBe("Some context");
		expect(arch.components).toEqual([]);
		expect(arch.interfaces).toEqual([]);
		expect(arch.tddAssignments).toEqual([]);
		expect(arch.decisions).toEqual([]);
		expect(arch.constraints).toEqual({ boundaries: [], patterns: [], prohibitions: [] });
	});

	test("malformed table returns empty array", () => {
		const content = `
## Components

Not a table at all
Just some text
`;
		const arch = parseArchitecture(content);
		expect(arch.components).toEqual([]);
	});

	test("interface without confidence", () => {
		const content = `
## Interfaces

### MyInterface (ws-3)
${FENCE}typescript
export function bar(): void;
${FENCE}
**Behavior:** Does something
**Invariants:**
- Invariant 1
**Error cases:**
- Error 1
`;
		const arch = parseArchitecture(content);
		expect(arch.interfaces).toHaveLength(1);
		expect(arch.interfaces[0]?.confidence).toBeUndefined();
		expect(arch.interfaces[0]?.name).toBe("MyInterface");
		expect(arch.interfaces[0]?.workstream).toBe("ws-3");
	});

	test("interface heading with and without parentheses", () => {
		const content = `
## Interfaces

### NamedInterface (ws-a)
**Behavior:** With parens

### ws-b
**Behavior:** Without parens
`;
		const arch = parseArchitecture(content);
		expect(arch.interfaces).toHaveLength(2);
		expect(arch.interfaces[0]?.name).toBe("NamedInterface");
		expect(arch.interfaces[0]?.workstream).toBe("ws-a");
		expect(arch.interfaces[1]?.name).toBe("ws-b");
		expect(arch.interfaces[1]?.workstream).toBe("ws-b");
	});

	test("decision missing confidence defaults to Medium", () => {
		const content = `
## Key Decisions

### D-1: Some Decision
**Chosen:** Option A
**Rejected:**
- Option B \u2014 reason B
`;
		const arch = parseArchitecture(content);
		expect(arch.decisions[0]?.confidence).toBe("Medium");
	});

	test("rejected items split on em-dash and regular dash", () => {
		const content = `
## Key Decisions

### D-1: Some Decision
**Chosen:** Option A
**Rejected:**
- Option B \u2014 em-dash reason
- Option C - hyphen reason
`;
		const arch = parseArchitecture(content);
		const rejected = arch.decisions[0]?.rejected ?? [];
		expect(rejected).toHaveLength(2);
		expect(rejected[0]).toEqual({ option: "Option B", reason: "em-dash reason" });
		expect(rejected[1]).toEqual({ option: "Option C", reason: "hyphen reason" });
	});
});

describe("validateArchitecture", () => {
	const validArch = parseArchitecture(FULL_ARCH);

	test("valid architecture returns no errors", () => {
		const result = validateArchitecture(validArch, ["ws-1", "ws-2"]);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	test("empty components returns error", () => {
		const arch = { ...validArch, components: [] };
		const result = validateArchitecture(arch, ["ws-1"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.path === "components")).toBe(true);
	});

	test("missing TDD assignment returns error", () => {
		const result = validateArchitecture(validArch, ["ws-1", "ws-2", "ws-3"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("ws-3"))).toBe(true);
	});

	test("full TDD workstream without interface returns error", () => {
		const arch = {
			...validArch,
			tddAssignments: [
				{ workstreamId: "ws-missing", tddMode: "full" as const, rationale: "critical" },
			],
			interfaces: [],
		};
		const result = validateArchitecture(arch, ["ws-missing"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.path === "interfaces")).toBe(true);
	});
});

describe("loadArchitecture", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "arch-test-"));
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("loads valid architecture file", async () => {
		const filePath = join(tmpDir, "architecture.md");
		await writeFile(filePath, FULL_ARCH);
		const arch = await loadArchitecture(filePath);
		expect(arch.context).toBe("This is the context for the architecture.");
		expect(arch.components).toHaveLength(2);
	});

	test("throws ArchitectureParseError for missing file", async () => {
		const filePath = join(tmpDir, "nonexistent.md");
		await expect(loadArchitecture(filePath)).rejects.toBeInstanceOf(ArchitectureParseError);
	});

	test("throws ArchitectureParseError for empty file", async () => {
		const filePath = join(tmpDir, "empty.md");
		await writeFile(filePath, "");
		await expect(loadArchitecture(filePath)).rejects.toBeInstanceOf(ArchitectureParseError);
	});
});
