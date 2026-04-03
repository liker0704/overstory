/**
 * Mission artifact scaffolding and root-role prompt materialization.
 *
 * Mission root agents run at the project root, so they do not receive the
 * worktree overlay file that sling-managed agents use. This module creates
 * a mission context file plus a rendered system prompt with
 * {{INSTRUCTION_PATH}} resolved to that context file.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildTemplateReplacements } from "../agents/overlay.ts";
import { loadConfig } from "../config.ts";
import { resolveBackend } from "../tracker/factory.ts";
import type { Mission } from "../types.ts";

export interface MissionArtifactPaths {
	root: string;
	missionMd: string;
	decisionsMd: string;
	openQuestionsMd: string;
	researchDir: string;
	currentStateMd: string;
	researchSummaryMd: string;
	planDir: string;
	workstreamsJson: string;
	architectureMd: string;
	testPlanYaml: string;
	refactorSpecsDir: string;
	resultsDir: string;
}

export interface MaterializedMissionRolePrompt {
	contextPath: string;
	promptPath: string;
}

function buildMissionPlanningContract(): string {
	return [
		"## Workstream Handoff Contract",
		"",
		"Treat `plan/workstreams.json` as a runtime-consumed contract, not a loose planning note.",
		"Before declaring the mission ready for `ov mission handoff`, ensure every dispatchable workstream satisfies all of these rules:",
		"",
		'- The file stays valid JSON with top-level shape `{ "version": 1, "workstreams": [...] }`.',
		"- Each workstream object uses only the runtime fields below:",
		"  - `id`: stable kebab-case workstream identifier",
		"  - `taskId`: non-empty task identifier; if the final canonical tracker ID is not known yet, choose a stable provisional ID and let `ov mission handoff` canonicalize it before dispatch",
		"  - `objective`: concise execution objective",
		"  - `fileScope`: array of repo-relative files or globs owned by that workstream",
		"  - `dependsOn`: array of workstream `id` strings",
		"  - `briefPath`: mission-relative markdown brief path, usually `workstreams/<id>/brief.md`",
		"  - `status`: one of `planned`, `active`, `paused`, `completed`",
		"- Do not use legacy/non-runtime fields like `name`, `capability`, `files`, or `dependencies`.",
		"- Every dispatchable workstream must have a real brief file at the referenced `briefPath` before handoff.",
		"- Keep `fileScope` ownership non-overlapping across workstreams.",
		"",
		"Minimum valid example:",
		"",
		"```json",
		"{",
		'  "version": 1,',
		'  "workstreams": [',
		"    {",
		'      "id": "docs-smoke",',
		'      "taskId": "docs-smoke",',
		'      "objective": "Write the mission smoke note.",',
		'      "fileScope": ["docs/mission-e2e-smoke.md"],',
		'      "dependsOn": [],',
		'      "briefPath": "workstreams/docs-smoke/brief.md",',
		'      "status": "planned"',
		"    }",
		"  ]",
		"}",
		"```",
		"",
		"Each referenced brief should be a focused execution brief for the lead: objective, exact file scope, constraints, acceptance checks, and any mission-specific context needed to execute without rereading the whole mission.",
	].join("\n");
}

function ensureArtifactRoot(mission: Pick<Mission, "id" | "artifactRoot">): string {
	if (!mission.artifactRoot) {
		throw new Error(`Mission ${mission.id} has no artifact root`);
	}
	return mission.artifactRoot;
}

export function getMissionArtifactPaths(
	mission: Pick<Mission, "id" | "artifactRoot">,
): MissionArtifactPaths {
	const root = ensureArtifactRoot(mission);
	const researchDir = join(root, "research");
	const planDir = join(root, "plan");
	return {
		root,
		missionMd: join(root, "mission.md"),
		decisionsMd: join(root, "decisions.md"),
		openQuestionsMd: join(root, "open-questions.md"),
		researchDir,
		currentStateMd: join(researchDir, "current-state.md"),
		researchSummaryMd: join(researchDir, "_summary.md"),
		planDir,
		workstreamsJson: join(planDir, "workstreams.json"),
		architectureMd: join(planDir, "architecture.md"),
		testPlanYaml: join(planDir, "test-plan.yaml"),
		refactorSpecsDir: join(planDir, "refactor-specs"),
		resultsDir: join(root, "results"),
	};
}

async function writeIfMissing(path: string, content: string): Promise<void> {
	const file = Bun.file(path);
	if (await file.exists()) {
		return;
	}
	await Bun.write(path, content);
}

export async function ensureMissionArtifacts(
	mission: Pick<Mission, "id" | "slug" | "objective" | "artifactRoot">,
): Promise<MissionArtifactPaths> {
	const paths = getMissionArtifactPaths(mission);
	await mkdir(paths.root, { recursive: true });
	await mkdir(paths.researchDir, { recursive: true });
	await mkdir(paths.planDir, { recursive: true });
	await mkdir(paths.refactorSpecsDir, { recursive: true });
	await mkdir(paths.resultsDir, { recursive: true });

	await writeIfMissing(
		paths.missionMd,
		[
			"# Mission",
			"",
			`- ID: ${mission.id}`,
			`- Slug: ${mission.slug}`,
			`- Objective: ${mission.objective}`,
			"",
			"## Current Understanding",
			"",
			"_To be updated by mission coordination roles._",
			"",
		].join("\n"),
	);
	await writeIfMissing(
		paths.decisionsMd,
		["# Decisions", "", "_Mission-level decisions will be recorded here._", ""].join("\n"),
	);
	await writeIfMissing(
		paths.openQuestionsMd,
		["# Open Questions", "", "_Blocking and non-blocking questions live here._", ""].join("\n"),
	);
	await writeIfMissing(
		paths.currentStateMd,
		["# Current State", "", "_Repository-grounded analysis goes here._", ""].join("\n"),
	);
	await writeIfMissing(
		paths.researchSummaryMd,
		["# Research Summary", "", "_High-signal synthesis goes here._", ""].join("\n"),
	);
	await writeIfMissing(
		paths.workstreamsJson,
		`${JSON.stringify({ version: 1, workstreams: [] }, null, 2)}\n`,
	);

	return paths;
}

export async function materializeMissionRolePrompt(opts: {
	overstoryDir: string;
	agentName: string;
	capability: string;
	roleLabel: string;
	mission: Pick<
		Mission,
		"id" | "slug" | "objective" | "artifactRoot" | "runId" | "phase" | "state"
	>;
	siblingNames?: Record<string, string>;
}): Promise<MaterializedMissionRolePrompt> {
	const { overstoryDir, agentName, capability, roleLabel, mission, siblingNames } = opts;
	const paths = await ensureMissionArtifacts(mission);
	const agentDir = join(overstoryDir, "agents", agentName);
	await mkdir(agentDir, { recursive: true });

	const contextPath = join(agentDir, "mission-context.md");
	const promptPath = join(agentDir, "system-prompt.md");
	const basePromptPath = join(overstoryDir, "agent-defs", `${capability}.md`);
	const basePromptFile = Bun.file(basePromptPath);
	const basePrompt = (await basePromptFile.exists()) ? await basePromptFile.text() : "";

	const context = [
		`# ${roleLabel} Context`,
		"",
		`- Mission ID: ${mission.id}`,
		`- Mission slug: ${mission.slug}`,
		`- Objective: ${mission.objective}`,
		`- Run ID: ${mission.runId ?? "none"}`,
		`- State: ${mission.state}`,
		`- Phase: ${mission.phase}`,
		"",
		"## Artifact Paths",
		"",
		`- Root: ${paths.root}`,
		`- mission.md: ${paths.missionMd}`,
		`- decisions.md: ${paths.decisionsMd}`,
		`- open-questions.md: ${paths.openQuestionsMd}`,
		`- research/current-state.md: ${paths.currentStateMd}`,
		`- research/_summary.md: ${paths.researchSummaryMd}`,
		`- plan/workstreams.json: ${paths.workstreamsJson}`,
		`- plan/architecture.md: ${paths.architectureMd}`,
		`- plan/test-plan.yaml: ${paths.testPlanYaml}`,
		`- plan/refactor-specs/: ${paths.refactorSpecsDir}`,
		`- results/: ${paths.resultsDir}`,
		"",
		"## Runtime Notes",
		"",
		"- You are mission-scoped.",
		`- Your canonical CLI agent name is \`${agentName}\`. Use that exact name for ov mail/ov status commands even when your capability is \`${capability}\`.`,
		"- Update mission artifacts directly under the paths above.",
		"- Use ov mail for coordination and operator questions.",
		"",
		...(siblingNames && Object.keys(siblingNames).length > 0
			? [
					"## Sibling Agent Names",
					"",
					"Use these exact names for `--to` in `ov mail send` commands:",
					"",
					...Object.entries(siblingNames).map(([role, name]) => `- ${role}: \`${name}\``),
					"",
				]
			: []),
		buildMissionPlanningContract(),
		"",
	].join("\n");

	// Apply template variable replacements (TRACKER_CLI, QUALITY_GATE_*, etc.)
	const projectRoot = dirname(overstoryDir);
	let renderedPrompt = basePrompt;
	try {
		const config = await loadConfig(projectRoot);
		const resolvedBackend = await resolveBackend(config.taskTracker.backend, projectRoot);
		const trackerCli =
			resolvedBackend === "github" ? "gh" : resolvedBackend === "seeds" ? "sd" : "bd";
		const replacements = buildTemplateReplacements({
			trackerCli,
			trackerName: resolvedBackend,
			qualityGates: config.project?.qualityGates,
			agentName,
		});
		for (const [key, value] of Object.entries(replacements)) {
			while (renderedPrompt.includes(key)) {
				renderedPrompt = renderedPrompt.replace(key, value);
			}
		}
	} catch {
		// Config load failure is non-fatal — proceed with unsubstituted prompt
	}

	// Inject shared mandate (mandatory waiting protocol etc.)
	const mandatePath = join(overstoryDir, "agent-defs", "shared-mandate.md");
	const mandateFile = Bun.file(mandatePath);
	if (await mandateFile.exists()) {
		const mandate = await mandateFile.text();
		renderedPrompt = `${renderedPrompt}\n\n${mandate}`;
	}

	// Replace {{INSTRUCTION_PATH}} with the context file path
	renderedPrompt = renderedPrompt.includes("{{INSTRUCTION_PATH}}")
		? renderedPrompt.replaceAll("{{INSTRUCTION_PATH}}", contextPath)
		: `${renderedPrompt}\n\nMission context: ${contextPath}\n`;

	await Bun.write(contextPath, `${context}\n`);
	await Bun.write(promptPath, `${renderedPrompt}\n`);

	return { contextPath, promptPath };
}

export function buildMissionRoleBeacon(opts: {
	agentName: string;
	missionId: string;
	contextPath: string;
}): string {
	return [
		`Read your mission context at ${opts.contextPath}.`,
		`Check mail with: ov mail check --agent ${opts.agentName}.`,
		`Begin mission ${opts.missionId} immediately.`,
	].join(" ");
}
