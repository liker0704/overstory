import type { OverstoryConfig } from "../../config-types.ts";
import type { HealthScore } from "../types.ts";
import { evaluatePolicy } from "./evaluator.ts";
import { checkAutoResume, executePolicyAction } from "./executor.ts";
import { isPolicyDisabled } from "./kill-switch.ts";
import type { PolicyActionRecord, PolicyEvaluationResult, PolicyRule } from "./types.ts";

// === Types ===

export interface PolicyOrchestrationOptions {
	overstoryDir: string;
	config: OverstoryConfig;
	score: HealthScore;
	history: PolicyActionRecord[];
	mailSend: (to: string, subject: string, body: string, type: string, payload: string) => void;
	logEvent?: (eventType: string, data: Record<string, unknown>) => void;
	lastEvaluationAt?: string;
}

// === Orchestrator ===

export async function runPolicyEvaluation(
	options: PolicyOrchestrationOptions,
): Promise<PolicyEvaluationResult | null> {
	const { overstoryDir, config, score, history, mailSend, logEvent, lastEvaluationAt } = options;

	// Handle missing healthPolicy config
	if (!config.healthPolicy) {
		return null;
	}

	const policyConfig = config.healthPolicy;

	// 1. Kill switch
	if (isPolicyDisabled(overstoryDir, config)) {
		return null;
	}

	// 2. Throttle: skip if evaluation interval hasn't elapsed
	if (lastEvaluationAt !== undefined) {
		const elapsed = Date.now() - new Date(lastEvaluationAt).getTime();
		if (elapsed < policyConfig.evaluationIntervalMs) {
			return null;
		}
	}

	// 3. Auto-resume: remove stale spawn-paused sentinel before evaluating
	const resumeResult = checkAutoResume(overstoryDir, policyConfig.maxPauseDurationMs);
	if (resumeResult.resumed) {
		logEvent?.("custom", {
			type: "health_auto_resume",
			details: resumeResult.details,
		});
	}

	// 4. Evaluate all policy rules
	const result = evaluatePolicy(score, policyConfig.rules as PolicyRule[], history, {
		dryRun: policyConfig.dryRun,
	});

	// 5. Execute triggered, non-suppressed actions
	for (const evaluation of result.evaluations) {
		if (evaluation.triggered && !evaluation.suppressed) {
			const actionResult = await executePolicyAction(
				evaluation.rule.action,
				evaluation.rule.id,
				{ overstoryDir, mailSend, logEvent },
				policyConfig.dryRun,
			);
			if (actionResult.executed) {
				evaluation.executedAt = new Date().toISOString();
			}
		}
	}

	return result;
}
