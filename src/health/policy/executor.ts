import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { PolicyAction } from "./types.ts";

// === Types ===

export interface ExecutionContext {
	overstoryDir: string;
	mailSend: (to: string, subject: string, body: string, type: string, payload: string) => void;
	logEvent?: (eventType: string, data: Record<string, unknown>) => void;
}

export interface ActionResult {
	action: PolicyAction;
	ruleId: string;
	executed: boolean;
	details: string;
	error?: string;
}

// === Action Executor ===

export async function executePolicyAction(
	action: PolicyAction,
	ruleId: string,
	context: ExecutionContext,
	dryRun: boolean,
): Promise<ActionResult> {
	if (dryRun) {
		return { action, ruleId, executed: false, details: `dry-run: would ${action}` };
	}

	try {
		const details = await runAction(action, ruleId, context);
		context.logEvent?.("custom", { type: "health_action", action, ruleId, executed: true, dryRun });
		return { action, ruleId, executed: true, details };
	} catch (err) {
		return { action, ruleId, executed: false, details: "failed", error: String(err) };
	}
}

async function runAction(
	action: PolicyAction,
	ruleId: string,
	context: ExecutionContext,
): Promise<string> {
	const spawnPausedPath = `${context.overstoryDir}/spawn-paused`;

	switch (action) {
		case "pause_spawning": {
			if (!existsSync(spawnPausedPath)) {
				await Bun.write(
					spawnPausedPath,
					JSON.stringify({ ruleId, pausedAt: new Date().toISOString() }),
				);
			}
			return "spawn-paused sentinel written";
		}

		case "resume_spawning": {
			if (existsSync(spawnPausedPath)) {
				unlinkSync(spawnPausedPath);
			}
			return "spawn-paused sentinel removed";
		}

		case "prioritize_merger": {
			context.mailSend(
				"coordinator",
				"health_policy: prioritize_merger",
				"Health policy recommends prioritizing merge queue processing",
				"health_policy_action",
				JSON.stringify({
					ruleId,
					action: "prioritize_merger",
					details: "Health score degraded — merge queue should be prioritized",
				}),
			);
			return "mail sent to coordinator: prioritize_merger";
		}

		case "escalate_mission_refresh": {
			context.mailSend(
				"coordinator",
				"health_policy: escalate_mission_refresh",
				"Health policy recommends mission health review",
				"health_policy_action",
				JSON.stringify({
					ruleId,
					action: "escalate_mission_refresh",
					details: "Mission health review recommended",
				}),
			);
			return "mail sent to coordinator: escalate_mission_refresh";
		}

		case "trigger_recovery": {
			context.mailSend(
				"coordinator",
				"health_policy: trigger_recovery",
				"Health policy recommends bounded recovery (zombie cleanup + stalled agent nudge)",
				"health_policy_action",
				JSON.stringify({
					ruleId,
					action: "trigger_recovery",
					details: "Bounded recovery: zombie cleanup + stalled agent nudge",
				}),
			);
			return "mail sent to coordinator: trigger_recovery";
		}
	}
}

// === Auto-Resume ===

export function checkAutoResume(
	overstoryDir: string,
	maxPauseDurationMs: number,
): { resumed: boolean; details?: string } {
	const spawnPausedPath = `${overstoryDir}/spawn-paused`;

	if (!existsSync(spawnPausedPath)) {
		return { resumed: false };
	}

	let pausedAt: string;
	try {
		const raw = readFileSync(spawnPausedPath, "utf-8");
		const data = JSON.parse(raw) as { pausedAt?: string };
		if (!data.pausedAt) {
			// Corrupt: missing field — remove and resume
			unlinkSync(spawnPausedPath);
			return { resumed: true, details: "auto-resumed from corrupt sentinel (missing pausedAt)" };
		}
		pausedAt = data.pausedAt;
	} catch {
		// Corrupt: parse error — remove and resume
		try {
			unlinkSync(spawnPausedPath);
		} catch {
			// ignore
		}
		return { resumed: true, details: "auto-resumed from corrupt sentinel (parse error)" };
	}

	const elapsed = Date.now() - new Date(pausedAt).getTime();
	if (elapsed > maxPauseDurationMs) {
		unlinkSync(spawnPausedPath);
		return {
			resumed: true,
			details: `auto-resumed after ${elapsed}ms (max: ${maxPauseDurationMs}ms)`,
		};
	}

	return { resumed: false };
}
