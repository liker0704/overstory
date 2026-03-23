import type { AgentSession } from "../agents/types.ts";
import type { MailClient } from "../mail/client.ts";
import type { MergeFailedPayload, RerouteRecommendationPayload } from "../mail/types.ts";
import type { MergeEntry } from "../merge/types.ts";
import type { CompatGateDecision, SurfaceChange } from "./types.ts";

export interface NotifyDeps {
	sessionStore: { getByName: (agentName: string) => AgentSession | null };
}

function formatChange(change: SurfaceChange): string {
	const kind = change.kind.toUpperCase();
	const { name, kind: symbolKind, filePath, line } = change.symbol;
	return `- ${kind} ${symbolKind} \`${name}\` (${filePath}:${line})`;
}

function buildAgentBody(
	entry: MergeEntry,
	decision: CompatGateDecision,
	reportPath: string,
): string {
	const breaking = decision.result.changes.filter((c) => c.severity === "breaking");
	const warnings = decision.result.changes.filter((c) => c.severity === "warning");

	const lines: string[] = [
		`Branch \`${entry.branchName}\` failed the compatibility gate.`,
		"",
		`Reason: ${decision.reason}`,
		"",
	];

	if (breaking.length > 0) {
		lines.push("## Breaking Changes");
		for (const c of breaking) {
			lines.push(formatChange(c));
		}
		lines.push("");
	}

	if (warnings.length > 0) {
		lines.push("## Warnings");
		for (const c of warnings) {
			lines.push(formatChange(c));
		}
		lines.push("");
	}

	lines.push(`Canonical branch: ${decision.result.branchA}`);
	lines.push(`Agent branch: ${decision.result.branchB}`);
	lines.push("");
	lines.push(`Full report: ${reportPath}`);
	lines.push("");
	lines.push("Suggested action: align exported symbols with canonical branch.");

	return lines.join("\n");
}

function buildRerouteBody(entry: MergeEntry, decision: CompatGateDecision): string {
	const breaking = decision.result.changes.filter((c) => c.severity === "breaking");
	const affectedFiles = [...new Set(decision.result.changes.map((c) => c.symbol.filePath))];

	const lines: string[] = [
		`Agent \`${entry.agentName}\` branch \`${entry.branchName}\` failed compat gate.`,
		`Reason: ${decision.reason}`,
		"",
	];

	if (breaking.length > 0) {
		lines.push("Affected symbols:");
		for (const c of breaking) {
			lines.push(`  ${c.symbol.name} (${c.kind})`);
		}
		lines.push("");
	}

	if (affectedFiles.length > 0) {
		lines.push("Affected files:");
		for (const f of affectedFiles) {
			lines.push(`  ${f}`);
		}
	}

	return lines.join("\n");
}

function resolveParent(agentName: string, deps: NotifyDeps): string {
	try {
		const session = deps.sessionStore.getByName(agentName);
		return session?.parentAgent ?? "coordinator";
	} catch {
		return "coordinator";
	}
}

export function notifyCompatFailure(
	mailClient: MailClient,
	entry: MergeEntry,
	decision: CompatGateDecision,
	reportPath: string,
	deps: NotifyDeps,
): void {
	const conflictFiles = [...new Set(decision.result.changes.map((c) => c.symbol.filePath))];

	const agentPayload = {
		branch: entry.branchName,
		taskId: entry.taskId,
		conflictFiles,
		errorMessage: decision.reason,
	} satisfies MergeFailedPayload;

	mailClient.send({
		from: "compat-gate",
		to: entry.agentName,
		subject: `Compat gate failed: ${entry.branchName}`,
		priority: "high",
		type: "merge_failed",
		payload: JSON.stringify(agentPayload),
		body: buildAgentBody(entry, decision, reportPath),
	});

	const parent = resolveParent(entry.agentName, deps);

	const reroutePayload = {
		taskId: entry.taskId,
		capability: entry.agentName,
		decision: {
			action: "recommend_reroute",
			reason: decision.reason,
			delay: 0,
		},
	} satisfies RerouteRecommendationPayload;

	mailClient.send({
		from: "compat-gate",
		to: parent,
		subject: `Reroute recommendation: ${entry.taskId}`,
		priority: "high",
		type: "reroute_recommendation",
		payload: JSON.stringify(reroutePayload),
		body: buildRerouteBody(entry, decision),
	});
}
