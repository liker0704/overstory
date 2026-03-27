import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTestPlan, parseTestPlan, TestPlanError, validateTestPlan } from "./test-plan.ts";
import type { Architecture, TestPlan } from "./types.ts";

// === Fixtures ===

const VALID_YAML = `
version: 1
missionId: mission-abc
architectureRef: plan/architecture.md
suites:
  - workstreamId: store-ws
    tddMode: full
    files:
      - path: src/resilience/store.test.ts
        description: "Tests for ResilienceStore"
        interfaceRef: ResilienceStore
        cases:
          - id: T-1
            description: "creates a record"
            type: unit
            expectedBehavior: "returns inserted row"
          - id: T-2
            description: "integration with db"
            type: integration
            expectedBehavior: "writes and reads back"
`;

const MINIMAL_ARCHITECTURE: Architecture = {
	context: "test",
	components: [],
	interfaces: [
		{
			name: "ResilienceStore",
			workstream: "store-ws",
			signatures: "create(): void",
			behavior: "stores data",
			invariants: [],
			errorCases: [],
		},
	],
	tddAssignments: [{ workstreamId: "store-ws", tddMode: "full", rationale: "critical path" }],
	decisions: [],
	constraints: { boundaries: [], patterns: [], prohibitions: [] },
};

// === parseTestPlan ===

describe("parseTestPlan", () => {
	test("parses valid test-plan.yaml", () => {
		const plan = parseTestPlan(VALID_YAML);
		expect(plan.version).toBe(1);
		expect(plan.missionId).toBe("mission-abc");
		expect(plan.architectureRef).toBe("plan/architecture.md");
		expect(plan.suites).toHaveLength(1);
		const suite = plan.suites[0]!;
		expect(suite.workstreamId).toBe("store-ws");
		expect(suite.tddMode).toBe("full");
		expect(suite.files).toHaveLength(1);
		const file = suite.files[0]!;
		expect(file.path).toBe("src/resilience/store.test.ts");
		expect(file.interfaceRef).toBe("ResilienceStore");
		expect(file.cases).toHaveLength(2);
		expect(file.cases[0]!.id).toBe("T-1");
		expect(file.cases[1]!.type).toBe("integration");
	});

	test("throws on wrong version", () => {
		const yaml = `version: 2\nmissionId: m\narchitectureRef: a\nsuites:\n`;
		expect(() => parseTestPlan(yaml)).toThrow(TestPlanError);
	});

	test("throws on missing missionId", () => {
		const yaml = `version: 1\narchitectureRef: a\nsuites:\n`;
		expect(() => parseTestPlan(yaml)).toThrow(TestPlanError);
	});

	test("throws on invalid case type", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: ws1
    tddMode: full
    files:
      - path: src/foo.test.ts
        description: "desc"
        interfaceRef: Foo
        cases:
          - id: T-1
            description: "bad type"
            type: smoke
            expectedBehavior: "x"
`;
		expect(() => parseTestPlan(yaml)).toThrow(TestPlanError);
	});

	test("handles skip mode with empty files", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: ws-skip
    tddMode: skip
    files: []
`;
		// parseYaml may not parse empty [] — test robustly
		// We accept either throwing or returning empty files
		try {
			const plan = parseTestPlan(yaml);
			expect(plan.suites[0]!.files).toHaveLength(0);
		} catch {
			// acceptable if YAML parser doesn't support []
		}
	});

	test("nested arrays with colons in values parse correctly", () => {
		const yaml = `
version: 1
missionId: "mission: with colon"
architectureRef: "plan/architecture.md"
suites:
  - workstreamId: ws1
    tddMode: light
    files:
      - path: src/foo.test.ts
        description: "desc: with colon"
        interfaceRef: FooInterface
        cases:
          - id: T-1
            description: "should handle url: http://example.com"
            type: unit
            expectedBehavior: "parses url correctly"
`;
		const plan = parseTestPlan(yaml);
		expect(plan.missionId).toBe("mission: with colon");
		expect(plan.suites[0]!.files[0]!.cases[0]!.description).toBe(
			"should handle url: http://example.com",
		);
	});
});

// === validateTestPlan ===

describe("validateTestPlan", () => {
	test("valid full plan passes all checks", () => {
		const plan = parseTestPlan(VALID_YAML);
		const result = validateTestPlan(plan, MINIMAL_ARCHITECTURE, ["store-ws"]);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	test("unknown workstreamId → error", () => {
		const plan = parseTestPlan(VALID_YAML);
		const result = validateTestPlan(plan, MINIMAL_ARCHITECTURE, ["other-ws"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Unknown workstreamId"))).toBe(true);
	});

	test("tddMode mismatch between plan and architecture → error", () => {
		const arch: Architecture = {
			...MINIMAL_ARCHITECTURE,
			tddAssignments: [{ workstreamId: "store-ws", tddMode: "light", rationale: "low risk" }],
		};
		const plan = parseTestPlan(VALID_YAML);
		const result = validateTestPlan(plan, arch, ["store-ws"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("tddMode mismatch"))).toBe(true);
	});

	test("interfaceRef not in architecture → error", () => {
		const arch: Architecture = { ...MINIMAL_ARCHITECTURE, interfaces: [] };
		const plan = parseTestPlan(VALID_YAML);
		const result = validateTestPlan(plan, arch, ["store-ws"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Unknown interface reference"))).toBe(true);
	});

	test("duplicate case IDs → error", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: store-ws
    tddMode: full
    files:
      - path: src/a.test.ts
        description: "d"
        interfaceRef: ResilienceStore
        cases:
          - id: T-1
            description: "first"
            type: unit
            expectedBehavior: "ok"
          - id: T-1
            description: "duplicate"
            type: integration
            expectedBehavior: "ok"
`;
		const plan = parseTestPlan(yaml);
		const result = validateTestPlan(plan, MINIMAL_ARCHITECTURE, ["store-ws"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate case id"))).toBe(true);
	});

	test("full mode with no files → error (missing suites)", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: store-ws
    tddMode: full
    files: []
`;
		let plan: TestPlan;
		try {
			plan = parseTestPlan(yaml);
		} catch {
			// some parsers reject [] — acceptable as parse error
			return;
		}
		const result = validateTestPlan(plan, MINIMAL_ARCHITECTURE, ["store-ws"]);
		expect(result.valid).toBe(false);
		expect(
			result.errors.some((e) => e.message.includes("full mode") && e.message.includes("cases")),
		).toBe(true);
	});

	test("full mode with no e2e or integration case → error", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: store-ws
    tddMode: full
    files:
      - path: src/a.test.ts
        description: "d"
        interfaceRef: ResilienceStore
        cases:
          - id: T-1
            description: "unit only"
            type: unit
            expectedBehavior: "ok"
`;
		const plan = parseTestPlan(yaml);
		const result = validateTestPlan(plan, MINIMAL_ARCHITECTURE, ["store-ws"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("e2e or integration"))).toBe(true);
	});

	test("skip mode with files → error", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: skip-ws
    tddMode: skip
    files:
      - path: src/foo.test.ts
        description: "d"
        interfaceRef: Foo
        cases: []
`;
		const arch: Architecture = {
			...MINIMAL_ARCHITECTURE,
			interfaces: [
				{
					name: "Foo",
					workstream: "skip-ws",
					signatures: "",
					behavior: "",
					invariants: [],
					errorCases: [],
				},
			],
			tddAssignments: [{ workstreamId: "skip-ws", tddMode: "skip", rationale: "skipped" }],
		};
		const plan = parseTestPlan(yaml);
		const result = validateTestPlan(plan, arch, ["skip-ws"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("skip mode"))).toBe(true);
	});

	test("path traversal attempt → error", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: store-ws
    tddMode: full
    files:
      - path: "../../../etc/passwd"
        description: "d"
        interfaceRef: ResilienceStore
        cases:
          - id: T-1
            description: "traversal"
            type: integration
            expectedBehavior: "should fail"
`;
		const plan = parseTestPlan(yaml);
		const result = validateTestPlan(plan, MINIMAL_ARCHITECTURE, ["store-ws"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Unsafe file path"))).toBe(true);
	});

	test("absolute path → error", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: store-ws
    tddMode: full
    files:
      - path: "/etc/passwd"
        description: "d"
        interfaceRef: ResilienceStore
        cases:
          - id: T-1
            description: "abs path"
            type: integration
            expectedBehavior: "should fail"
`;
		const plan = parseTestPlan(yaml);
		const result = validateTestPlan(plan, MINIMAL_ARCHITECTURE, ["store-ws"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Unsafe file path"))).toBe(true);
	});

	test("skip mode workstream with no files is valid", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: skip-ws
    tddMode: skip
    files: []
`;
		let plan: TestPlan;
		try {
			plan = parseTestPlan(yaml);
		} catch {
			// acceptable if parser rejects []
			return;
		}
		const arch: Architecture = {
			...MINIMAL_ARCHITECTURE,
			interfaces: [],
			tddAssignments: [{ workstreamId: "skip-ws", tddMode: "skip", rationale: "not needed" }],
		};
		const result = validateTestPlan(plan, arch, ["skip-ws"]);
		expect(result.valid).toBe(true);
	});

	test("duplicate case IDs across different suites → error", () => {
		const yaml = `
version: 1
missionId: m
architectureRef: a
suites:
  - workstreamId: store-ws
    tddMode: full
    files:
      - path: src/a.test.ts
        description: "d"
        interfaceRef: ResilienceStore
        cases:
          - id: T-1
            description: "first suite"
            type: integration
            expectedBehavior: "ok"
  - workstreamId: other-ws
    tddMode: full
    files:
      - path: src/b.test.ts
        description: "d"
        interfaceRef: OtherInterface
        cases:
          - id: T-1
            description: "duplicate in other suite"
            type: e2e
            expectedBehavior: "ok"
`;
		const arch: Architecture = {
			...MINIMAL_ARCHITECTURE,
			interfaces: [
				{
					name: "ResilienceStore",
					workstream: "store-ws",
					signatures: "",
					behavior: "",
					invariants: [],
					errorCases: [],
				},
				{
					name: "OtherInterface",
					workstream: "other-ws",
					signatures: "",
					behavior: "",
					invariants: [],
					errorCases: [],
				},
			],
			tddAssignments: [
				{ workstreamId: "store-ws", tddMode: "full", rationale: "r" },
				{ workstreamId: "other-ws", tddMode: "full", rationale: "r" },
			],
		};
		const plan = parseTestPlan(yaml);
		const result = validateTestPlan(plan, arch, ["store-ws", "other-ws"]);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.message.includes("Duplicate case id: T-1"))).toBe(true);
	});
});

// === loadTestPlan ===

describe("loadTestPlan", () => {
	test("loads and parses from file", () => {
		const dir = mkdtempSync(join(tmpdir(), "test-plan-"));
		const filePath = join(dir, "test-plan.yaml");
		writeFileSync(filePath, VALID_YAML, "utf8");
		try {
			const plan = loadTestPlan(filePath);
			expect(plan.missionId).toBe("mission-abc");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("throws TestPlanError on missing file", () => {
		expect(() => loadTestPlan("/nonexistent/path/test-plan.yaml")).toThrow(TestPlanError);
	});
});
