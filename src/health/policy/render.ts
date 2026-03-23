/**
 * Pure render functions for policy evaluation output.
 * No side effects — all functions return formatted strings.
 */

import { accent, brand, color, muted } from "../../logging/color.ts";
import { thickSeparator } from "../../logging/theme.ts";
import type { PolicyActionRecord, PolicyEvaluationResult } from "./types.ts";

// === PolicyStatusInfo ===

export interface PolicyStatusInfo {
	enabled: boolean;
	disabled: boolean;
	dryRun: boolean;
	ruleCount: number;
	lastEvaluationAt?: string;
	recentTriggered: number;
}

// === Badge helpers ===

function evaluationBadge(eval_: {
	triggered: boolean;
	suppressed: boolean;
	dryRun: boolean;
}): string {
	if (!eval_.triggered) return muted("[SKIP]");
	if (eval_.suppressed) return color.yellow("[SUPPRESSED]");
	if (eval_.dryRun) return color.cyan("[DRY-RUN]");
	return color.green("[EXECUTED]");
}

function historyBadge(record: PolicyActionRecord): string {
	if (!record.triggered) return muted("[SKIP]");
	if (record.suppressed) return color.yellow("[SUPPRESSED]");
	if (record.dryRun) return color.cyan("[DRY-RUN]");
	return color.green("[EXECUTED]");
}

function priorityColor(priority: string): string {
	switch (priority) {
		case "critical":
			return color.red(priority);
		case "high":
			return color.yellow(priority);
		case "medium":
			return color.cyan(priority);
		default:
			return muted(priority);
	}
}

// === renderPolicyEvaluation ===

export function renderPolicyEvaluation(result: PolicyEvaluationResult): string {
	const lines: string[] = [];

	const ts = new Date(result.timestamp).toLocaleTimeString();
	const overall = result.score.overall;
	const grade = result.score.grade;

	lines.push(brand.bold("Policy Evaluation"));
	lines.push(thickSeparator());
	lines.push(`  Score: ${overall}/100  Grade: ${grade}  ${muted(`at ${ts}`)}`);
	lines.push("");

	const triggered = result.evaluations.filter((e) => e.triggered);
	const skipped = result.evaluations.filter((e) => !e.triggered);

	if (triggered.length > 0) {
		lines.push(`  ${color.bold("Triggered Rules")}  ${muted(`(${triggered.length})`)}`);
		lines.push("");

		for (const ev of triggered) {
			const badge = evaluationBadge(ev);
			const idPart = accent(ev.rule.id);
			const priorityPart = priorityColor(ev.rule.priority);
			const actionPart = color.bold(ev.rule.action);
			lines.push(`  ${badge}  ${idPart}  ${muted("priority:")} ${priorityPart}  ${muted("action:")} ${actionPart}`);
			if (ev.suppressReason !== undefined) {
				lines.push(`           ${muted(`suppress: ${ev.suppressReason}`)}`);
			}
		}
		lines.push("");
	}

	if (skipped.length > 0) {
		lines.push(`  ${muted(`Skipped Rules (${skipped.length})`)}`);
		for (const ev of skipped) {
			lines.push(`  ${muted("[SKIP]")}  ${muted(ev.rule.id)}  ${muted(ev.rule.action)}`);
		}
		lines.push("");
	}

	const executed = triggered.filter((e) => !e.dryRun && !e.suppressed).length;
	const dryRun = triggered.filter((e) => e.dryRun && !e.suppressed).length;
	const suppressed = triggered.filter((e) => e.suppressed).length;

	lines.push(
		muted(
			`  Total: ${result.evaluations.length}  Triggered: ${triggered.length}  Executed: ${executed}  Dry-run: ${dryRun}  Suppressed: ${suppressed}`,
		),
	);

	return lines.join("\n");
}

// === renderPolicyHistory ===

export function renderPolicyHistory(records: PolicyActionRecord[]): string {
	const lines: string[] = [];

	lines.push(brand.bold("Policy Action History"));
	lines.push(thickSeparator());
	lines.push("");

	if (records.length === 0) {
		lines.push(`  ${muted("No policy actions recorded.")}`);
		lines.push("");
	} else {
		for (const record of records) {
			const badge = historyBadge(record);
			const ts = new Date(record.timestamp).toLocaleString();
			const idPart = accent(record.ruleId);
			const actionPart = color.bold(record.action);
			lines.push(`  ${badge}  ${muted(ts)}  ${idPart}  ${actionPart}`);
			if (record.details) {
				lines.push(`           ${muted(record.details)}`);
			}
		}
		lines.push("");
		lines.push(muted(`  Showing ${records.length} record(s)`));
	}

	return lines.join("\n");
}

// === renderPolicyStatus ===

export function renderPolicyStatus(info: PolicyStatusInfo): string {
	const lines: string[] = [];

	lines.push(`  ${color.bold("Health Policy")}`);

	if (!info.enabled && !info.disabled) {
		lines.push(`    ${muted("Not configured")}`);
		return lines.join("\n");
	}

	if (info.disabled) {
		lines.push(`    Status: ${color.red("disabled")} ${muted("(kill switch active)")}`);
	} else {
		lines.push(`    Status: ${color.green("enabled")}`);
	}

	const modePart = info.dryRun ? color.cyan("dry-run") : color.green("live");
	lines.push(`    Mode:   ${modePart}`);
	lines.push(`    Rules:  ${info.ruleCount}`);

	if (info.lastEvaluationAt !== undefined) {
		const ts = new Date(info.lastEvaluationAt).toLocaleString();
		lines.push(`    Last:   ${muted(ts)}`);
	}

	lines.push(`    Recent triggered: ${info.recentTriggered}`);

	return lines.join("\n");
}
