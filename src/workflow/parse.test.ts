import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	parseAcceptanceCriteria,
	parseComponents,
	parseRisks,
	parseTaskBreakdown,
	parseTaskMetadata,
	parseWorkflow,
} from "./parse.ts";

// ── parseTaskMetadata ──────────────────────────────────────────────────────────────────────────

describe("parseTaskMetadata", () => {
	it("parses valid task.md", () => {
		const content = `Status: executing
Created: 2026-01-31 20:30:00
Last-updated: 2026-02-08 22:30:00

# Task: my-feature

This is the task description.
More details here.`;

		const result = parseTaskMetadata(content);
		expect(result.slug).toBe("my-feature");
		expect(result.status).toBe("executing");
		expect(result.created).toBe("2026-01-31 20:30:00");
		expect(result.lastUpdated).toBe("2026-02-08 22:30:00");
		expect(result.description).toBe("This is the task description.\nMore details here.");
	});

	it("trims whitespace from all values", () => {
		const content = `Status:   in-progress
Created:   2026-01-01
Last-updated:   2026-01-02

# Task:   spaced-slug

  Description with leading spaces.`;

		const result = parseTaskMetadata(content);
		expect(result.slug).toBe("spaced-slug");
		expect(result.status).toBe("in-progress");
		expect(result.created).toBe("2026-01-01");
		expect(result.lastUpdated).toBe("2026-01-02");
		expect(result.description).toBe("Description with leading spaces.");
	});

	it("returns empty strings for missing fields", () => {
		const content = `# Task: minimal`;
		const result = parseTaskMetadata(content);
		expect(result.slug).toBe("minimal");
		expect(result.status).toBe("");
		expect(result.created).toBe("");
		expect(result.lastUpdated).toBe("");
		expect(result.description).toBe("");
	});

	it("handles empty content", () => {
		const result = parseTaskMetadata("");
		expect(result.slug).toBe("");
		expect(result.status).toBe("");
		expect(result.description).toBe("");
	});

	it("handles content with no header", () => {
		const content = `Status: ready\nCreated: 2026-01-01\nJust some text`;
		const result = parseTaskMetadata(content);
		expect(result.slug).toBe("");
		expect(result.description).toBe("");
	});
});

// ── parseTaskBreakdown ─────────────────────────────────────────────────────────────────────────

describe("parseTaskBreakdown", () => {
	it("parses single task with all fields", () => {
		const content = `## task-01: Implement feature X

Description of the task.

**Dependencies:** None
**TDD:** full`;

		const result = parseTaskBreakdown(content);
		expect(result).toHaveLength(1);
		const task = result[0]!;
		expect(task.id).toBe("task-01");
		expect(task.title).toBe("Implement feature X");
		expect(task.dependencies).toEqual([]);
		expect(task.tddMode).toBe("full");
		expect(task.description).toContain("Description of the task.");
	});

	it("parses multiple tasks", () => {
		const content = `## task-01: First task

Do the first thing.

**Dependencies:** None
**TDD:** skip

## task-02: Second task

Do the second thing.

**Dependencies:** task-01
**TDD:** full`;

		const result = parseTaskBreakdown(content);
		expect(result).toHaveLength(2);
		expect(result[0]!.id).toBe("task-01");
		expect(result[1]!.id).toBe("task-02");
		expect(result[1]!.dependencies).toEqual(["task-01"]);
	});

	it("parses comma-separated dependencies", () => {
		const content = `## task-03: Third task

**Dependencies:** task-01, task-02
**TDD:** full`;

		const result = parseTaskBreakdown(content);
		expect(result[0]!.dependencies).toEqual(["task-01", "task-02"]);
	});

	it("handles TDD: skip", () => {
		const content = `## task-01: Skip TDD

**Dependencies:** None
**TDD:** skip`;
		const result = parseTaskBreakdown(content);
		expect(result[0]!.tddMode).toBe("skip");
	});

	it("handles unknown TDD value as null", () => {
		const content = `## task-01: Unknown TDD

**Dependencies:** None
**TDD:** partial`;
		const result = parseTaskBreakdown(content);
		expect(result[0]!.tddMode).toBeNull();
	});

	it("handles missing TDD field as null", () => {
		const content = `## task-01: No TDD

**Dependencies:** None`;
		const result = parseTaskBreakdown(content);
		expect(result[0]!.tddMode).toBeNull();
	});

	it("returns empty array for empty content", () => {
		expect(parseTaskBreakdown("")).toEqual([]);
	});

	it("returns empty array for content with no task headings", () => {
		expect(parseTaskBreakdown("# Not a task heading\nSome text")).toEqual([]);
	});
});

// ── parseRisks ────────────────────────────────────────────────────────────────────────────────

describe("parseRisks", () => {
	it("parses valid risk table", () => {
		const content = `| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| API breaking change | Medium | High | Version pinning |`;

		const result = parseRisks(content);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			risk: "API breaking change",
			likelihood: "Medium",
			impact: "High",
			mitigation: "Version pinning",
		});
	});

	it("parses multiple risk rows", () => {
		const content = `| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Risk A | Low | Low | Fix A |
| Risk B | High | High | Fix B |`;

		const result = parseRisks(content);
		expect(result).toHaveLength(2);
		expect(result[0]!.risk).toBe("Risk A");
		expect(result[1]!.risk).toBe("Risk B");
	});

	it("returns empty array when no table found", () => {
		expect(parseRisks("No table here")).toEqual([]);
	});

	it("returns empty array for empty content", () => {
		expect(parseRisks("")).toEqual([]);
	});

	it("handles table with extra surrounding text", () => {
		const content = `Some introduction.

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Data loss | High | Critical | Backups |

Some footer.`;

		const result = parseRisks(content);
		expect(result).toHaveLength(1);
		expect(result[0]!.risk).toBe("Data loss");
	});
});

// ── parseAcceptanceCriteria ────────────────────────────────────────────────────────────────────

describe("parseAcceptanceCriteria", () => {
	it("parses checked and unchecked items", () => {
		const content = `## Definition of Done

- [x] All tests pass
- [ ] Documentation updated`;

		const result = parseAcceptanceCriteria(content);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ text: "All tests pass", checked: true });
		expect(result[1]).toEqual({ text: "Documentation updated", checked: false });
	});

	it("stops at next heading", () => {
		const content = `## Definition of Done

- [x] Item one

## Another Section

- [ ] Should not be parsed`;

		const result = parseAcceptanceCriteria(content);
		expect(result).toHaveLength(1);
		expect(result[0]!.text).toBe("Item one");
	});

	it("returns empty array when section not found", () => {
		expect(parseAcceptanceCriteria("No DoD here")).toEqual([]);
	});

	it("returns empty array for empty content", () => {
		expect(parseAcceptanceCriteria("")).toEqual([]);
	});

	it("handles case-insensitive [X] checkbox", () => {
		const content = `## Definition of Done

- [X] Case insensitive check`;

		const result = parseAcceptanceCriteria(content);
		expect(result).toHaveLength(1);
		expect(result[0]!.checked).toBe(true);
	});

	it("handles multiple criteria with mixed states", () => {
		const content = `## Definition of Done

- [x] Done item 1
- [ ] Undone item
- [x] Done item 2`;

		const result = parseAcceptanceCriteria(content);
		expect(result).toHaveLength(3);
		expect(result[0]!.checked).toBe(true);
		expect(result[1]!.checked).toBe(false);
		expect(result[2]!.checked).toBe(true);
	});
});

// ── parseComponents ───────────────────────────────────────────────────────────────────────────

describe("parseComponents", () => {
	it("parses valid component table", () => {
		const content = `| Action | Path | Purpose |
|--------|------|---------|
| CREATE | \`src/feature.ts\` | Implements new feature |
| MODIFY | \`src/config.ts\` | Add configuration |`;

		const result = parseComponents(content);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			action: "CREATE",
			path: "src/feature.ts",
			purpose: "Implements new feature",
		});
		expect(result[1]).toEqual({
			action: "MODIFY",
			path: "src/config.ts",
			purpose: "Add configuration",
		});
	});

	it("strips backticks from path", () => {
		const content = `| Action | Path | Purpose |
|--------|------|---------|
| DELETE | \`src/old.ts\` | Remove old file |`;

		const result = parseComponents(content);
		expect(result[0]!.path).toBe("src/old.ts");
	});

	it("supports all valid actions", () => {
		const content = `| Action | Path | Purpose |
|--------|------|---------|
| CREATE | a.ts | Create |
| MODIFY | b.ts | Modify |
| DELETE | c.ts | Delete |
| REUSE | d.ts | Reuse |`;

		const result = parseComponents(content);
		expect(result).toHaveLength(4);
		expect(result.map((c) => c.action)).toEqual(["CREATE", "MODIFY", "DELETE", "REUSE"]);
	});

	it("skips rows with invalid action", () => {
		const content = `| Action | Path | Purpose |
|--------|------|---------|
| INVALID | src/x.ts | Bad action |
| CREATE | src/y.ts | Good action |`;

		const result = parseComponents(content);
		expect(result).toHaveLength(1);
		expect(result[0]!.action).toBe("CREATE");
	});

	it("returns empty array when no table found", () => {
		expect(parseComponents("No table here")).toEqual([]);
	});

	it("returns empty array for empty content", () => {
		expect(parseComponents("")).toEqual([]);
	});
});

// ── parseWorkflow ─────────────────────────────────────────────────────────────────────────────

describe("parseWorkflow", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "ov-parse-test-"));
		await mkdir(join(tmpDir, "plan"), { recursive: true });
		await mkdir(join(tmpDir, "research"), { recursive: true });
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	const writeFile = (path: string, content: string) => Bun.write(join(tmpDir, path), content);

	it("parses a complete workflow with all files", async () => {
		await writeFile(
			"task.md",
			`Status: executing
Created: 2026-01-01
Last-updated: 2026-01-02

# Task: full-test

Full test description.`,
		);

		await writeFile(
			"plan/tasks.md",
			`## task-01: Do thing

**Dependencies:** None
**TDD:** full`,
		);

		await writeFile(
			"plan/plan.md",
			`# Plan

This is the plan.`,
		);

		await writeFile(
			"plan/risks.md",
			`| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Break stuff | Low | High | Tests |`,
		);

		await writeFile(
			"plan/acceptance.md",
			`## Definition of Done

- [x] Tests pass`,
		);

		await writeFile(
			"architecture.md",
			`| Action | Path | Purpose |
|--------|------|---------|
| CREATE | \`src/foo.ts\` | New file |`,
		);

		await writeFile("research/_summary.md", `Research summary here.`);

		const result = await parseWorkflow(tmpDir);
		expect(result.metadata.slug).toBe("full-test");
		expect(result.tasks).toHaveLength(1);
		expect(result.risks).toHaveLength(1);
		expect(result.acceptanceCriteria).toHaveLength(1);
		expect(result.components).toHaveLength(1);
		expect(result.planSummary).toContain("plan");
		expect(result.researchSummary).toBe("Research summary here.");
		expect(result.architectureContext).not.toBeNull();
	});

	it("throws with correct message when task.md is missing", async () => {
		await writeFile("plan/tasks.md", `## task-01: Thing\n\n**Dependencies:** None`);

		await expect(parseWorkflow(tmpDir)).rejects.toThrow(
			"Required file missing: task.md. Ensure this is a valid claude-code-workflow task directory.",
		);
	});

	it("throws with correct message when plan/tasks.md is missing", async () => {
		await writeFile("task.md", `# Task: no-tasks\n\nDescription.`);

		await expect(parseWorkflow(tmpDir)).rejects.toThrow(
			"Required file missing: plan/tasks.md. Ensure this is a valid claude-code-workflow task directory.",
		);
	});

	it("returns null for missing optional files", async () => {
		await writeFile("task.md", `# Task: minimal\n\nDescription.`);
		await writeFile("plan/tasks.md", `## task-01: Thing\n\n**Dependencies:** None`);

		const result = await parseWorkflow(tmpDir);
		expect(result.planSummary).toBeNull();
		expect(result.researchSummary).toBeNull();
		expect(result.architectureContext).toBeNull();
		expect(result.risks).toEqual([]);
		expect(result.acceptanceCriteria).toEqual([]);
		expect(result.components).toEqual([]);
	});
});
