import type { TddMode } from "./types.ts";
import { TDD_MODES } from "./types.ts";

export function formatTddStatusLine(
	workstreams: ReadonlyArray<{ id: string; tddMode: TddMode }>,
): string {
	if (workstreams.length === 0) return "TDD: none";

	const counts = new Map<TddMode, number>();
	for (const ws of workstreams) {
		counts.set(ws.tddMode, (counts.get(ws.tddMode) ?? 0) + 1);
	}

	const modes = TDD_MODES.filter((m) => (counts.get(m) ?? 0) > 0);

	if (modes.length === 1) {
		const mode = modes[0] as TddMode;
		const count = counts.get(mode) as number;
		const label = count === 1 ? "workstream" : "workstreams";
		return `TDD: ${mode} (${count} ${label})`;
	}

	const parts = modes.map((m) => `${counts.get(m) as number} ${m}`);
	return `TDD: ${parts.join(", ")}`;
}

export function formatBuilderTddOverlay(
	tddMode: TddMode,
	testPlanPath?: string,
	architecturePath?: string,
): string {
	switch (tddMode) {
		case "full": {
			const sections: string[] = [
				"## TDD Mode: Full",
				"",
				"Test files are **READ-ONLY**. Your job is to make existing tests pass — do NOT modify them.",
				"",
				"**Failure mode: TEST_FILE_MODIFICATION** — modifying any test file is an automatic failure.",
			];
			if (testPlanPath) {
				sections.push("", "### Test Plan", "", `See: \`${testPlanPath}\``);
			}
			if (architecturePath) {
				sections.push("", "### Architecture", "", `See: \`${architecturePath}\``);
			}
			return sections.join("\n");
		}
		case "light": {
			const sections: string[] = [
				"## TDD Mode: Light",
				"",
				"A test plan exists for guidance. You may create or modify tests as needed.",
			];
			if (testPlanPath) {
				sections.push("", "### Test Plan", "", `See: \`${testPlanPath}\` for coverage guidance.`);
			}
			return sections.join("\n");
		}
		case "skip":
			return "";
		case "refactor":
			return [
				"## TDD Mode: Refactor",
				"",
				"Behavior must remain **unchanged**. Test files are **READ-ONLY**. You may restructure the implementation freely.",
				"",
				"**Failure mode: BEHAVIOR_CHANGE** — any observable behavior change is an automatic failure.",
			].join("\n");
	}
}

export function formatReviewerTddOverlay(tddMode: TddMode): string {
	switch (tddMode) {
		case "full":
			return [
				"## TDD Review Checks",
				"",
				"1. **Test file integrity:** Run `git diff -- '*.test.*'` — if any test file was modified, this is an automatic **FAIL** (TEST_FILE_MODIFICATION).",
				"2. **Architecture alignment:** Verify implementation aligns with the provided architecture spec.",
			].join("\n");
		case "light":
			return [
				"## TDD Review Checks",
				"",
				"1. **Architecture alignment:** Verify implementation aligns with the provided architecture spec.",
			].join("\n");
		case "skip":
			return "";
		case "refactor":
			return [
				"## TDD Review Checks",
				"",
				"1. **Test file integrity:** Run `git diff -- '*.test.*'` — if any test file was modified, this is an automatic **FAIL** (TEST_FILE_MODIFICATION).",
				"2. **Behavior preservation:** All existing tests must pass with identical assertions.",
			].join("\n");
	}
}

export function formatLeadTddOverlay(tddMode: TddMode): string {
	switch (tddMode) {
		case "full":
			return [
				"## TDD Orchestration",
				"",
				"**Workflow override:** Spawn the tester agent BEFORE builders. Builders are dispatched AFTER the tester completes.",
				"",
				"**Failure mode: TDD_ORDER_VIOLATION** — spawning builders before the tester completes is an automatic failure.",
			].join("\n");
		case "light":
		case "skip":
		case "refactor":
			return "";
	}
}

export function formatTddOverlay(
	capability: string,
	tddMode?: TddMode,
	testPlanPath?: string,
	architecturePath?: string,
): string {
	if (tddMode === undefined) return "";

	switch (capability) {
		case "builder":
			return formatBuilderTddOverlay(tddMode, testPlanPath, architecturePath);
		case "reviewer":
			return formatReviewerTddOverlay(tddMode);
		case "lead":
		case "lead-mission":
			return formatLeadTddOverlay(tddMode);
		default:
			return "";
	}
}
