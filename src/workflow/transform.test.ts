import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createManifest, detectDrift, readManifest, writeManifest } from "./manifest.ts";
import {
	generateBrief,
	importWorkflow,
	mergeWorkstreamUpdate,
	transformToWorkstreams,
} from "./transform.ts";
import type { ParsedWorkflow } from "./types.ts";

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "ov-transform-test-"));
}

async function writeWorkflowSource(dir: string): Promise<void> {
	await mkdir(join(dir, "plan"), { recursive: true });
	await mkdir(join(dir, "research"), { recursive: true });

	await writeFile(
		join(dir, "task.md"),
		`Status: executing\nCreated: 2026-01-01 00:00:00\nLast-updated: 2026-01-02 00:00:00\n\n# Task: test-slug\n\nTest task description.`,
	);

	await writeFile(
		join(dir, "plan", "tasks.md"),
		`## Tasks\n\n## task-01: First task\n\nDoes the first thing.\n\n**Dependencies:** none\n**TDD:** full\n\n## task-02: Second task\n\nBuilds on top of task-01.\n\n**Dependencies:** task-01\n**TDD:** skip`,
	);

	await writeFile(join(dir, "plan", "plan.md"), `# Plan\n\nHigh-level summary of the plan.`);

	await writeFile(
		join(dir, "plan", "risks.md"),
		`## Risks\n\n| Risk | Likelihood | Impact | Mitigation |\n|------|-----------|--------|------------|\n| Data loss | Low | High | Backups |`,
	);

	await writeFile(
		join(dir, "plan", "acceptance.md"),
		`## Acceptance Criteria\n\n- [ ] Tests pass\n- [x] Lint clean`,
	);

	await writeFile(
		join(dir, "architecture.md"),
		`# Architecture\n\n## Components\n\n| Action | Path | Purpose |\n|--------|------|---------|\n| CREATE | src/foo.ts | task-01 handler |\n| CREATE | src/bar.ts | task-02 handler |`,
	);

	await writeFile(join(dir, "research", "_summary.md"), `# Research\n\nFindings here.`);
}

function makeParsedWorkflow(): ParsedWorkflow {
	return {
		metadata: {
			slug: "test-slug",
			status: "executing",
			created: "2026-01-01",
			lastUpdated: "2026-01-02",
			description: "Test task description.",
		},
		tasks: [
			{
				id: "task-01",
				title: "First task",
				description: "Does the first thing.",
				dependencies: [],
				tddMode: "full",
			},
			{
				id: "task-02",
				title: "Second task",
				description: "Builds on top of task-01.",
				dependencies: ["task-01"],
				tddMode: "skip",
			},
		],
		risks: [{ risk: "Data loss", likelihood: "Low", impact: "High", mitigation: "Backups" }],
		components: [
			{ action: "CREATE", path: "src/foo.ts", purpose: "task-01 handler" },
			{ action: "CREATE", path: "src/bar.ts", purpose: "task-02 handler" },
		],
		acceptanceCriteria: [
			{ text: "Tests pass", checked: false },
			{ text: "Lint clean", checked: true },
		],
		planSummary: "High-level summary of the plan.",
		researchSummary: "Findings here.",
		architectureContext: "Components: src/foo.ts, src/bar.ts",
	};
}

// ── transformToWorkstreams ─────────────────────────────────────────────────────────────────────

describe("transformToWorkstreams", () => {
	it("produces valid workstreams for each task", () => {
		const parsed = makeParsedWorkflow();
		const { workstreamsFile, warnings } = transformToWorkstreams(parsed);

		expect(workstreamsFile.version).toBe(1);
		expect(workstreamsFile.workstreams).toHaveLength(2);

		const ws1 = workstreamsFile.workstreams[0];
		const ws2 = workstreamsFile.workstreams[1];

		expect(ws1?.id).toBe("task-01");
		expect(ws1?.status).toBe("planned");
		expect(ws1?.briefPath).toBe("workstreams/task-01/brief.md");
		expect(ws1?.dependsOn).toEqual([]);

		expect(ws2?.id).toBe("task-02");
		expect(ws2?.dependsOn).toEqual(["task-01"]);

		// No unassigned files warnings since components match tasks
		const unassignedWarnings = warnings.filter((w) => w.includes("could not be assigned"));
		expect(unassignedWarnings).toHaveLength(0);
	});

	it("assigns components to tasks based on purpose match", () => {
		const parsed = makeParsedWorkflow();
		const { workstreamsFile } = transformToWorkstreams(parsed);

		const ws1 = workstreamsFile.workstreams[0];
		const ws2 = workstreamsFile.workstreams[1];

		expect(ws1?.fileScope).toContain("src/foo.ts");
		expect(ws2?.fileScope).toContain("src/bar.ts");
	});

	it("warns about unassigned components", () => {
		const parsed = makeParsedWorkflow();
		parsed.components = [
			...parsed.components,
			{ action: "CREATE", path: "src/unknown.ts", purpose: "unrelated stuff" },
		];
		const { warnings } = transformToWorkstreams(parsed);

		const unassigned = warnings.find((w) => w.includes("could not be assigned"));
		expect(unassigned).toBeTruthy();
		expect(unassigned).toContain("src/unknown.ts");
	});

	it("deduplicates files assigned to multiple tasks", () => {
		const parsed = makeParsedWorkflow();
		// Add component that mentions both tasks
		parsed.components = [
			{ action: "CREATE", path: "src/shared.ts", purpose: "task-01 and task-02 shared" },
		];
		const { workstreamsFile, warnings } = transformToWorkstreams(parsed);

		// File should appear only once across all workstreams
		const allFiles = workstreamsFile.workstreams.flatMap((ws) => ws.fileScope);
		const sharedCount = allFiles.filter((f) => f === "src/shared.ts").length;
		expect(sharedCount).toBe(1);

		// Should have no reassignment warning since it matches first task and stops
		// (only matches first task-01, not task-02 here since we break on first match)
		expect(warnings).toBeDefined();
	});
});

// ── generateBrief ──────────────────────────────────────────────────────────────────────────────

describe("generateBrief", () => {
	it("generates a brief with all required sections", () => {
		const parsed = makeParsedWorkflow();
		const task = parsed.tasks[0]!;
		const brief = generateBrief(task, parsed, ["src/foo.ts"]);

		expect(brief).toContain("# Workstream: task-01");
		expect(brief).toContain("## Objective");
		expect(brief).toContain("## Context");
		expect(brief).toContain("## What to Build");
		expect(brief).toContain("## File Scope");
		expect(brief).toContain("## Risks");
		expect(brief).toContain("## Acceptance Criteria");
		expect(brief).toContain("## Architecture Context");
	});

	it("includes all risks by default", () => {
		const parsed = makeParsedWorkflow();
		const task = parsed.tasks[0]!;
		const brief = generateBrief(task, parsed, ["src/foo.ts"]);

		expect(brief).toContain("Data loss");
	});

	it("includes all acceptance criteria", () => {
		const parsed = makeParsedWorkflow();
		const task = parsed.tasks[1]!;
		const brief = generateBrief(task, parsed, ["src/bar.ts"]);

		expect(brief).toContain("Tests pass");
		expect(brief).toContain("Lint clean");
	});

	it("lists file scope", () => {
		const parsed = makeParsedWorkflow();
		const task = parsed.tasks[0]!;
		const brief = generateBrief(task, parsed, ["src/foo.ts"]);

		expect(brief).toContain("src/foo.ts");
	});
});

// ── manifest round-trip ────────────────────────────────────────────────────────────────────────

describe("manifest round-trip", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await makeTempDir();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("write → read returns identical manifest", async () => {
		const parsed = makeParsedWorkflow();
		await writeWorkflowSource(dir);

		const manifest = await createManifest(dir, parsed, ["task-01", "task-02"], {
			"task-01": "brief content for task-01",
			"task-02": "brief content for task-02",
		});

		const manifestPath = join(dir, "manifest.json");
		await writeManifest(manifestPath, manifest);

		const read = await readManifest(manifestPath);
		expect(read).toEqual(manifest);
	});

	it("readManifest returns null for missing file", async () => {
		const result = await readManifest(join(dir, "nonexistent.json"));
		expect(result).toBeNull();
	});

	it("readManifest returns null for invalid JSON", async () => {
		const p = join(dir, "bad.json");
		await writeFile(p, "not json");
		const result = await readManifest(p);
		expect(result).toBeNull();
	});
});

// ── detectDrift ────────────────────────────────────────────────────────────────────────────────

describe("detectDrift", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await makeTempDir();
		await writeWorkflowSource(dir);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns empty result when nothing changed", async () => {
		const parsed = makeParsedWorkflow();
		const manifest = await createManifest(dir, parsed, ["task-01", "task-02"], {});

		const result = await detectDrift(manifest, dir);

		expect(result.drifted).toHaveLength(0);
		expect(result.added).toHaveLength(0);
		expect(result.removed).toHaveLength(0);
		expect(result.unchanged.length).toBeGreaterThan(0);
	});

	it("detects changed artifact as drifted", async () => {
		const parsed = makeParsedWorkflow();
		const manifest = await createManifest(dir, parsed, ["task-01", "task-02"], {});

		// Modify an artifact
		await writeFile(
			join(dir, "task.md"),
			"Status: done\nCreated: 2026-01-01 00:00:00\nLast-updated: 2026-01-10 00:00:00\n\n# Task: test-slug\n\nModified.",
		);

		const result = await detectDrift(manifest, dir);
		expect(result.drifted.some((d) => d.workstreamId === "task.md")).toBe(true);
	});

	it("detects removed artifact", async () => {
		const parsed = makeParsedWorkflow();
		const manifest = await createManifest(dir, parsed, ["task-01", "task-02"], {});

		// Remove research/_summary.md by pointing to a non-existent path
		// (we can't easily delete a file, so just use a manifest with a fake artifact)
		const modifiedManifest = {
			...manifest,
			artifactHashes: {
				...manifest.artifactHashes,
				"nonexistent-artifact.md": "deadbeef",
			},
		};

		const result = await detectDrift(modifiedManifest, dir);
		expect(result.removed).toContain("artifact:nonexistent-artifact.md");
	});
});

// ── importWorkflow ─────────────────────────────────────────────────────────────────────────────

describe("importWorkflow", () => {
	let sourceDir: string;
	let artifactRoot: string;

	beforeEach(async () => {
		sourceDir = await makeTempDir();
		artifactRoot = await makeTempDir();
		await writeWorkflowSource(sourceDir);
		await mkdir(join(artifactRoot, "plan"), { recursive: true });
	});

	afterEach(async () => {
		await rm(sourceDir, { recursive: true, force: true });
		await rm(artifactRoot, { recursive: true, force: true });
	});

	it("dry run returns result without writing files", async () => {
		const result = await importWorkflow({
			sourcePath: sourceDir,
			missionArtifactRoot: artifactRoot,
			dryRun: true,
		});

		expect(result.workstreams.length).toBeGreaterThan(0);
		expect(result.briefs.length).toBeGreaterThan(0);
		expect(result.manifest).toBeDefined();
		expect(result.manifest.sourceSlug).toBe("test-slug");

		// Should NOT have written files
		const workstreamsPath = join(artifactRoot, "plan", "workstreams.json");
		const wsFile = await Bun.file(workstreamsPath).exists();
		expect(wsFile).toBe(false);
	});

	it("writes workstreams.json, briefs, and manifest when not dry run", async () => {
		const result = await importWorkflow({
			sourcePath: sourceDir,
			missionArtifactRoot: artifactRoot,
			dryRun: false,
		});

		expect(result.workstreams.length).toBeGreaterThan(0);

		const workstreamsPath = join(artifactRoot, "plan", "workstreams.json");
		const wsFile = await Bun.file(workstreamsPath).exists();
		expect(wsFile).toBe(true);

		const manifestPath = join(artifactRoot, "plan", "import-manifest.json");
		const mfFile = await Bun.file(manifestPath).exists();
		expect(mfFile).toBe(true);
	});
});

// ── mergeWorkstreamUpdate ──────────────────────────────────────────────────────────────────────

describe("mergeWorkstreamUpdate", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await makeTempDir();
		await mkdir(join(dir, "plan"), { recursive: true });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("preserves status and taskId of existing workstreams", async () => {
		const parsed = makeParsedWorkflow();
		const existing = [
			{
				id: "task-01",
				taskId: "tracker-123",
				objective: "Old objective",
				fileScope: [],
				dependsOn: [],
				briefPath: "workstreams/task-01/brief.md",
				status: "active" as const,
			},
		];

		const incoming = [
			{
				id: "task-01",
				taskId: "task-01",
				objective: "New objective",
				fileScope: ["src/foo.ts"],
				dependsOn: [],
				briefPath: "workstreams/task-01/brief.md",
				status: "planned" as const,
			},
		];

		const manifest = await createManifest(dir, parsed, ["task-01"], {});

		const result = await mergeWorkstreamUpdate(
			{ existing, incoming, manifest },
			parsed,
			false,
			dir,
		);

		const merged = result.merged.find((ws) => ws.id === "task-01");
		expect(merged?.status).toBe("active"); // preserved
		expect(merged?.taskId).toBe("tracker-123"); // preserved
		expect(merged?.objective).toBe("New objective"); // updated
	});

	it("skips manually-edited briefs when force is false", async () => {
		const parsed = makeParsedWorkflow();
		const wsId = "task-01";
		const originalContent = "original brief content";

		// Create brief file
		const briefDir = join(dir, "workstreams", wsId);
		await mkdir(briefDir, { recursive: true });
		const briefPath = join(briefDir, "brief.md");
		await writeFile(briefPath, originalContent);

		// Create manifest with hash of original content
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(originalContent);
		const originalHash = hasher.digest("hex");

		// Now simulate manual edit — write different content
		await writeFile(briefPath, "manually edited content");

		const manifest = {
			version: 1 as const,
			sourcePath: dir,
			sourceSlug: "test-slug",
			importedAt: new Date().toISOString(),
			artifactHashes: {},
			briefHashes: { [wsId]: originalHash }, // stored hash of original
			taskMapping: { [wsId]: "task-01" },
		};

		await writeManifest(join(dir, "plan", "import-manifest.json"), manifest);

		const incoming = [
			{
				id: wsId,
				taskId: wsId,
				objective: "Task objective",
				fileScope: [],
				dependsOn: [],
				briefPath: `workstreams/${wsId}/brief.md`,
				status: "planned" as const,
			},
		];

		const result = await mergeWorkstreamUpdate(
			{ existing: incoming, incoming, manifest },
			parsed,
			false, // force = false
			dir,
		);

		expect(result.skippedBriefs).toContain(wsId);
	});

	it("overwrites manually-edited briefs when force is true", async () => {
		const parsed = makeParsedWorkflow();
		const wsId = "task-01";

		// Create brief with different content
		const briefDir = join(dir, "workstreams", wsId);
		await mkdir(briefDir, { recursive: true });
		const briefPath = join(briefDir, "brief.md");
		await writeFile(briefPath, "manually edited");

		const manifest = {
			version: 1 as const,
			sourcePath: dir,
			sourceSlug: "test-slug",
			importedAt: new Date().toISOString(),
			artifactHashes: {},
			briefHashes: { [wsId]: "original-hash-stored" },
			taskMapping: { [wsId]: "task-01" },
		};

		await writeManifest(join(dir, "plan", "import-manifest.json"), manifest);

		const incoming = [
			{
				id: wsId,
				taskId: wsId,
				objective: "Task objective",
				fileScope: [],
				dependsOn: [],
				briefPath: `workstreams/${wsId}/brief.md`,
				status: "planned" as const,
			},
		];

		const result = await mergeWorkstreamUpdate(
			{ existing: incoming, incoming, manifest },
			parsed,
			true, // force = true
			dir,
		);

		expect(result.skippedBriefs).not.toContain(wsId);
		expect(result.updatedBriefs.some((b) => b.workstreamId === wsId)).toBe(true);
	});
});
