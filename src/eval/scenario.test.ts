import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvalScenarioError } from "../errors.ts";
import { loadScenario } from "./scenario.ts";

async function cleanupTempDir(dir: string): Promise<void> {
	const { rm } = await import("node:fs/promises");
	await rm(dir, { recursive: true, force: true });
}

describe("loadScenario", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "overstory-eval-test-"));
	});

	afterEach(async () => {
		await cleanupTempDir(tempDir);
	});

	async function writeScenarioFiles(
		dir: string,
		scenarioYaml: string,
		assertionsYaml: string,
	): Promise<void> {
		await writeFile(join(dir, "scenario.yaml"), scenarioYaml, "utf8");
		await writeFile(join(dir, "assertions.yaml"), assertionsYaml, "utf8");
	}

	test("loads a valid scenario with all fields", async () => {
		const scenarioDir = join(tempDir, "smoke-test");
		await mkdir(scenarioDir);
		await writeScenarioFiles(
			scenarioDir,
			`description: "Smoke test for dispatch flow"
timeout_ms: 60000
config_overrides:
  agents:
    maxConcurrent: 3
startup_actions:
  - command: "sd create --title test"
    description: "Create a seed task"
`,
			`assertions:
  - kind: min_workers_spawned
    expected: 1
  - kind: no_zombies
    expected: true
`,
		);

		const scenario = await loadScenario(scenarioDir);

		expect(scenario.name).toBe("smoke-test");
		expect(scenario.path).toBe(scenarioDir);
		expect(scenario.description).toBe("Smoke test for dispatch flow");
		expect(scenario.timeoutMs).toBe(60000);
		expect(scenario.repoTemplatePath).toBeNull();
		expect(scenario.configOverrides).toEqual({ agents: { maxConcurrent: 3 } });
		expect(scenario.startupActions).toHaveLength(1);
		expect(scenario.startupActions[0]).toEqual({
			command: "sd create --title test",
			description: "Create a seed task",
		});
		expect(scenario.assertions).toHaveLength(2);
		expect(scenario.assertions[0]).toEqual({ kind: "min_workers_spawned", expected: 1 });
		expect(scenario.assertions[1]).toEqual({ kind: "no_zombies", expected: true });
	});

	test("uses default timeout when timeout_ms is omitted", async () => {
		const scenarioDir = join(tempDir, "default-timeout");
		await mkdir(scenarioDir);
		await writeScenarioFiles(
			scenarioDir,
			`description: "Simple test"
`,
			`assertions:
  - kind: no_zombies
    expected: true
`,
		);

		const scenario = await loadScenario(scenarioDir);
		expect(scenario.timeoutMs).toBe(300_000);
	});

	test("detects repo-template directory when present", async () => {
		const scenarioDir = join(tempDir, "with-template");
		await mkdir(scenarioDir);
		await mkdir(join(scenarioDir, "repo-template"));
		await writeScenarioFiles(
			scenarioDir,
			`description: "Has template"
`,
			`assertions:
  - kind: tasks_completed
    expected: 2
`,
		);

		const scenario = await loadScenario(scenarioDir);
		expect(scenario.repoTemplatePath).toBe(join(scenarioDir, "repo-template"));
	});

	test("throws EvalScenarioError when scenario.yaml is missing", async () => {
		const scenarioDir = join(tempDir, "missing-scenario");
		await mkdir(scenarioDir);
		await writeFile(
			join(scenarioDir, "assertions.yaml"),
			`assertions:\n  - kind: no_zombies\n    expected: true\n`,
		);

		await expect(loadScenario(scenarioDir)).rejects.toThrow(EvalScenarioError);
	});

	test("throws EvalScenarioError when assertions.yaml is missing", async () => {
		const scenarioDir = join(tempDir, "missing-assertions");
		await mkdir(scenarioDir);
		await writeFile(join(scenarioDir, "scenario.yaml"), `description: "A test"\n`);

		await expect(loadScenario(scenarioDir)).rejects.toThrow(EvalScenarioError);
	});

	test("throws EvalScenarioError when description is missing", async () => {
		const scenarioDir = join(tempDir, "no-description");
		await mkdir(scenarioDir);
		await writeScenarioFiles(
			scenarioDir,
			`timeout_ms: 1000
`,
			`assertions:
  - kind: no_zombies
    expected: true
`,
		);

		await expect(loadScenario(scenarioDir)).rejects.toThrow(EvalScenarioError);
	});

	test("throws EvalScenarioError when assertions list is empty", async () => {
		const scenarioDir = join(tempDir, "empty-assertions");
		await mkdir(scenarioDir);
		await writeScenarioFiles(
			scenarioDir,
			`description: "A test"
`,
			`assertions: []
`,
		);

		await expect(loadScenario(scenarioDir)).rejects.toThrow(EvalScenarioError);
	});

	test("throws EvalScenarioError for unknown assertion kind", async () => {
		const scenarioDir = join(tempDir, "bad-kind");
		await mkdir(scenarioDir);
		await writeScenarioFiles(
			scenarioDir,
			`description: "Bad kind"
`,
			`assertions:
  - kind: unknown_thing
    expected: true
`,
		);

		await expect(loadScenario(scenarioDir)).rejects.toThrow(EvalScenarioError);
	});

	test("supports assertion with optional label", async () => {
		const scenarioDir = join(tempDir, "labelled");
		await mkdir(scenarioDir);
		await writeScenarioFiles(
			scenarioDir,
			`description: "With label"
`,
			`assertions:
  - kind: max_cost
    label: "Under budget"
    expected: 5.0
`,
		);

		const scenario = await loadScenario(scenarioDir);
		expect(scenario.assertions[0]).toEqual({
			kind: "max_cost",
			label: "Under budget",
			expected: 5.0,
		});
	});

	test("empty startup_actions when omitted", async () => {
		const scenarioDir = join(tempDir, "no-startup");
		await mkdir(scenarioDir);
		await writeScenarioFiles(
			scenarioDir,
			`description: "No startup actions"
`,
			`assertions:
  - kind: no_zombies
    expected: true
`,
		);

		const scenario = await loadScenario(scenarioDir);
		expect(scenario.startupActions).toEqual([]);
	});

	describe("temporal assertion parsing", () => {
		test("parses before assertion with eventA and eventB", async () => {
			const scenarioDir = join(tempDir, "before-assertion");
			await mkdir(scenarioDir);
			await writeScenarioFiles(
				scenarioDir,
				`description: "Before assertion test"
`,
				`assertions:
  - kind: before
    expected: true
    eventA:
      eventType: spawn
      agentName: scout-1
    eventB:
      eventType: spawn
      agentName: builder-1
`,
			);

			const scenario = await loadScenario(scenarioDir);
			const a = scenario.assertions[0];
			expect(a?.kind).toBe("before");
			expect(a?.eventA).toEqual({ eventType: "spawn", agentName: "scout-1" });
			expect(a?.eventB).toEqual({ eventType: "spawn", agentName: "builder-1" });
		});

		test("parses within assertion with eventA, eventB, and windowMs", async () => {
			const scenarioDir = join(tempDir, "within-assertion");
			await mkdir(scenarioDir);
			await writeScenarioFiles(
				scenarioDir,
				`description: "Within assertion test"
`,
				`assertions:
  - kind: within
    expected: true
    windowMs: 60000
    eventA:
      eventType: spawn
    eventB:
      eventType: result
`,
			);

			const scenario = await loadScenario(scenarioDir);
			const a = scenario.assertions[0];
			expect(a?.kind).toBe("within");
			expect(a?.windowMs).toBe(60000);
			expect(a?.eventA).toEqual({ eventType: "spawn" });
			expect(a?.eventB).toEqual({ eventType: "result" });
		});

		test("parses event_count assertion with selector", async () => {
			const scenarioDir = join(tempDir, "event-count-assertion");
			await mkdir(scenarioDir);
			await writeScenarioFiles(
				scenarioDir,
				`description: "Event count assertion test"
`,
				`assertions:
  - kind: event_count
    expected: 3
    selector:
      eventType: tool_start
`,
			);

			const scenario = await loadScenario(scenarioDir);
			const a = scenario.assertions[0];
			expect(a?.kind).toBe("event_count");
			expect(a?.expected).toBe(3);
			expect(a?.selector).toEqual({ eventType: "tool_start" });
		});

		test("throws when before assertion is missing eventA", async () => {
			const scenarioDir = join(tempDir, "before-missing-eventA");
			await mkdir(scenarioDir);
			await writeScenarioFiles(
				scenarioDir,
				`description: "Missing eventA"
`,
				`assertions:
  - kind: before
    expected: true
    eventB:
      eventType: spawn
`,
			);

			await expect(loadScenario(scenarioDir)).rejects.toThrow(EvalScenarioError);
		});

		test("throws when within assertion is missing windowMs", async () => {
			const scenarioDir = join(tempDir, "within-missing-windowMs");
			await mkdir(scenarioDir);
			await writeScenarioFiles(
				scenarioDir,
				`description: "Missing windowMs"
`,
				`assertions:
  - kind: within
    expected: true
    eventA:
      eventType: spawn
    eventB:
      eventType: result
`,
			);

			await expect(loadScenario(scenarioDir)).rejects.toThrow(EvalScenarioError);
		});

		test("parses custom assertion with hookPath", async () => {
			const scenarioDir = join(tempDir, "custom-hookpath");
			await mkdir(scenarioDir);
			await writeScenarioFiles(
				scenarioDir,
				`description: "Custom hook assertion"
`,
				`assertions:
  - kind: custom
    expected: true
    hookPath: /path/to/hook.ts
`,
			);

			const scenario = await loadScenario(scenarioDir);
			const a = scenario.assertions[0];
			expect(a?.kind).toBe("custom");
			expect(a?.hookPath).toBe("/path/to/hook.ts");
		});
	});
});
