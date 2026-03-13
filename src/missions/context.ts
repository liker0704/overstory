/**
 * Mission artifact scaffolding and root-role prompt materialization.
 *
 * Mission root agents run at the project root, so they do not receive the
 * worktree overlay file that sling-managed agents use. This module creates
 * a mission context file plus a rendered system prompt with
 * {{INSTRUCTION_PATH}} resolved to that context file.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
	resultsDir: string;
}

export interface MaterializedMissionRolePrompt {
	contextPath: string;
	promptPath: string;
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
	mission: Pick<Mission, "id" | "slug" | "objective" | "artifactRoot" | "runId" | "phase" | "state">;
}): Promise<MaterializedMissionRolePrompt> {
	const { overstoryDir, agentName, capability, roleLabel, mission } = opts;
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
		`- results/: ${paths.resultsDir}`,
		"",
		"## Runtime Notes",
		"",
		"- You are mission-scoped.",
		"- Update mission artifacts directly under the paths above.",
		"- Use ov mail for coordination and operator questions.",
		"",
	].join("\n");

	const renderedPrompt = basePrompt.includes("{{INSTRUCTION_PATH}}")
		? basePrompt.replaceAll("{{INSTRUCTION_PATH}}", contextPath)
		: `${basePrompt}\n\nMission context: ${contextPath}\n`;

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
