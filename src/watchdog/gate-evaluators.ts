/**
 * Gate evaluators for mission lifecycle engine.
 *
 * Pure functions that check whether an async gate's resolution condition is met.
 * Each evaluator returns whether the condition is met, the trigger to fire,
 * and optionally a nudge target/message if the condition is not met.
 */

import type { MailStore } from "../mail/store.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { Mission } from "../types.ts";

export interface GateEvalResult {
	met: boolean;
	trigger?: string;
	nudgeTarget?: string;
	nudgeMessage?: string;
	unknown?: boolean;
}

/** Check if research phase has completed: analyst sent result mail to coordinator. */
export function evaluateAwaitResearch(
	mission: Mission,
	mailStore: MailStore | null,
): GateEvalResult {
	if (!mailStore) return { met: false };

	// Check if analyst dispatched (dispatch mail from coordinator to analyst exists)
	const analystName = mission.analystSessionId ? `mission-analyst-${mission.slug}` : null;
	if (!analystName) {
		return {
			met: false,
			nudgeTarget: `coordinator-${mission.slug}`,
			nudgeMessage: "Dispatch analyst for research phase",
		};
	}

	// Check if analyst sent research result — check coordinator's inbox
	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = mailStore.getAll({ to: coordinatorName });
	const hasResult = msgs.some((m) => m.type === "result" && m.from.includes("analyst"));
	if (hasResult) {
		return { met: true, trigger: "research_complete" };
	}

	return {
		met: false,
		nudgeTarget: analystName,
		nudgeMessage: "Complete research and send result mail to coordinator",
	};
}

/** Check if coordinator has evaluated research and is ready to advance. */
export function evaluateUnderstandReady(
	mission: Mission,
	mailStore?: MailStore | null,
): GateEvalResult {
	// Coordinator freezes mission → "frozen" trigger
	if (mission.state === "frozen") {
		return { met: true, trigger: "frozen" };
	}
	// Coordinator advanced phase → "ready" trigger
	if (mission.phase !== "understand") {
		return { met: true, trigger: "ready" };
	}
	if (mailStore) {
		const coordName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";
		const msgs = mailStore.getAll({ to: coordName });

		// Auto-resolve if "Plan complete" mail arrived (analyst finished planning)
		const planComplete = msgs.find(
			(m) => m.type === "result" && m.subject?.toLowerCase().includes("plan complete"),
		);
		if (planComplete) {
			return { met: true, trigger: "ready" };
		}

		// If analyst has been dispatched for planning, suppress nudge — work is in progress.
		// Check for "Planning phase" dispatch from coordinator to analyst.
		const analystName = mission.slug
			? `mission-analyst-${mission.slug}`
			: "mission-analyst";
		const allMsgs = mailStore.getAll({ to: analystName });
		const planningDispatched = allMsgs.find(
			(m) =>
				m.type === "dispatch" &&
				m.subject?.toLowerCase().includes("planning phase"),
		);
		if (planningDispatched) {
			// Analyst is working on the plan — don't nudge coordinator, just wait
			return { met: false };
		}
	}
	return {
		met: false,
		nudgeTarget: `coordinator-${mission.slug}`,
		nudgeMessage: "Research complete. Evaluate findings and advance to plan when ready.",
	};
}

/** Check if workstreams.json has been populated by analyst. */
export async function evaluateAwaitPlan(
	mission: Mission,
	artifactRoot: string,
): Promise<GateEvalResult> {
	try {
		const path = `${artifactRoot}/plan/workstreams.json`;
		const file = Bun.file(path);
		if (!(await file.exists())) return { met: false };
		const content = await file.json();
		const ws = content?.workstreams;
		if (Array.isArray(ws) && ws.length > 0) {
			return { met: true, trigger: "plan_written" };
		}
	} catch {
		// File doesn't exist or invalid JSON — not ready
	}
	return {
		met: false,
		nudgeTarget: `mission-analyst-${mission.slug}`,
		nudgeMessage: "Write workstream plan to workstreams.json",
	};
}

/** Check if architect has completed design: architect_ready mail + files exist. */
export async function evaluateArchitectDesign(
	mission: Mission,
	artifactRoot: string,
	mailStore: MailStore | null,
): Promise<GateEvalResult> {
	if (!mailStore) return { met: false };

	// Corroborating evidence: architecture.md + test-plan.yaml must exist
	const archPath = `${artifactRoot}/plan/architecture.md`;
	const testPlanPath = `${artifactRoot}/plan/test-plan.yaml`;
	const archExists = await Bun.file(archPath).exists();
	const testPlanExists = await Bun.file(testPlanPath).exists();

	if (!archExists || !testPlanExists) {
		return {
			met: false,
			nudgeTarget: `architect-${mission.slug}`,
			nudgeMessage: "Complete architecture.md and test-plan.yaml, then send architect_ready",
		};
	}

	// Check for architect_ready mail from architect capability
	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = mailStore.getAll({ to: coordinatorName });
	const hasArchitectReady = msgs.some(
		(m) => m.type === "status" && m.subject.includes("architect_ready"),
	);
	if (hasArchitectReady) {
		return { met: true, trigger: "architect_ready" };
	}

	return {
		met: false,
		nudgeTarget: `architect-${mission.slug}`,
		nudgeMessage: "Architecture artifacts exist. Send architect_ready mail to coordinator.",
	};
}

/** Check if coordinator has called ov mission handoff (phase changed to execute). */
export function evaluateAwaitHandoff(mission: Mission): GateEvalResult {
	if (mission.phase === "execute" || mission.phase === "done") {
		return { met: true, trigger: "handoff_complete" };
	}
	return {
		met: false,
		nudgeTarget: `coordinator-${mission.slug}`,
		nudgeMessage: "All prerequisites met. Call 'ov mission handoff' to start execution.",
	};
}

/** Check if any active workstream has been merged. */
export function evaluateWsCompletion(
	mission: Mission,
	mailStore: MailStore | null,
): GateEvalResult {
	if (!mailStore) return { met: false };

	// Check for 'merged' mail sent to execution director or coordinator
	const edName = `execution-director-${mission.slug}`;
	const msgs = mailStore.getAll({ to: edName });
	const mergedMail = msgs.find((m) => m.type === "merged");
	if (mergedMail) {
		return {
			met: true,
			trigger: "ws_merged",
			// Pass merged workstream info via nudgeMessage for the handler
			nudgeMessage: mergedMail.body,
		};
	}

	return { met: false };
}

/** Check if architecture_final mail has been received. */
export function evaluateArchFinal(mission: Mission, mailStore: MailStore | null): GateEvalResult {
	if (!mailStore) return { met: false };

	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = mailStore.getAll({ to: coordinatorName });
	const architectName = `architect-${mission.slug}`;
	const hasFinal = msgs.some(
		(m) =>
			m.from.includes(architectName) &&
			(m.subject.includes("architecture_final") || m.subject.includes("Architecture Finalization")),
	);

	if (hasFinal) {
		return { met: true, trigger: "architecture_final" };
	}

	return {
		met: false,
		nudgeTarget: `architect-${mission.slug}`,
		nudgeMessage: "Finalize architecture.md and send architecture_final mail.",
	};
}

/** Check if coordinator has dispatched analyst for planning. */
export function evaluateDispatchPlanning(
	mission: Mission,
	mailStore: MailStore | null,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const analystName = `mission-analyst-${mission.slug}`;
	const msgs = mailStore.getAll({ to: analystName });
	const hasDispatch = msgs.some((m) => m.type === "dispatch");
	if (hasDispatch) {
		return { met: true, trigger: "planning_started" };
	}
	return {
		met: false,
		nudgeTarget: `coordinator-${mission.slug}`,
		nudgeMessage: "Dispatch analyst for planning phase",
	};
}

/** Check if architect has been dispatched for architecture review (post-merge). */
export function evaluateArchReviewDispatch(
	mission: Mission,
	mailStore: MailStore | null,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const architectName = `architect-${mission.slug}`;
	const msgs = mailStore.getAll({ to: architectName });
	const hasDispatch = msgs.some(
		(m) => m.type === "dispatch" && m.subject.toLowerCase().includes("architecture review"),
	);
	if (hasDispatch) {
		return { met: true, trigger: "review_dispatched" };
	}
	return {
		met: false,
		nudgeTarget: `coordinator-${mission.slug}`,
		nudgeMessage: "Dispatch architect for post-merge architecture review",
	};
}

/** Check if refactor builders have completed. */
export function evaluateRefactorCompletion(
	mission: Mission,
	mailStore: MailStore | null,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const edName = `execution-director-${mission.slug}`;
	const msgs = mailStore.getAll({ to: edName });
	const hasDone = msgs.some((m) => m.type === "worker_done" || m.type === "merged");
	if (hasDone) {
		return { met: true, trigger: "refactor_done" };
	}
	return {
		met: false,
		nudgeTarget: edName,
		nudgeMessage: "Check refactor builder progress",
	};
}

/** Check if summary artifact has been produced. */
export async function evaluateSummaryReady(
	mission: Mission,
	artifactRoot: string,
): Promise<GateEvalResult> {
	try {
		const summaryPath = `${artifactRoot}/results/summary.md`;
		const exists = await Bun.file(summaryPath).exists();
		if (exists) {
			return { met: true, trigger: "summary_ready" };
		}
	} catch {
		// File check failed
	}
	return {
		met: false,
		nudgeTarget: `mission-analyst-${mission.slug}`,
		nudgeMessage: "Produce final mission summary",
	};
}

/** Check if architecture review has completed (approved or stuck). */
export function evaluateArchReviewComplete(
	mission: Mission,
	mailStore: MailStore | null,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = mailStore.getAll({ to: coordinatorName });

	// Check for architecture review completion signals
	const hasApproved = msgs.some(
		(m) =>
			m.subject.toLowerCase().includes("architecture review") &&
			(m.type === "result" || m.subject.toLowerCase().includes("approved")),
	);
	if (hasApproved) {
		return { met: true, trigger: "approved" };
	}

	return {
		met: false,
		nudgeTarget: `architect-${mission.slug}`,
		nudgeMessage: "Complete architecture review and report results",
	};
}

/** Dispatch gate evaluator based on the current node ID. */
export async function evaluateGate(
	nodeId: string,
	mission: Mission,
	stores: {
		mailStore: MailStore | null;
		sessionStore: SessionStore;
	},
	artifactRoot: string,
): Promise<GateEvalResult> {
	// Node IDs follow cellType:nodeName convention
	const parts = nodeId.split(":");
	const nodeName = parts[1];

	switch (nodeName) {
		case "await-research":
			return evaluateAwaitResearch(mission, stores.mailStore);
		case "evaluate":
			return evaluateUnderstandReady(mission, stores.mailStore);
		case "dispatch-planning":
			return evaluateDispatchPlanning(mission, stores.mailStore);
		case "await-plan":
			return evaluateAwaitPlan(mission, artifactRoot);
		case "architect-design":
			return evaluateArchitectDesign(mission, artifactRoot, stores.mailStore);
		case "await-handoff":
			return evaluateAwaitHandoff(mission);
		case "await-ws-completion":
			return evaluateWsCompletion(mission, stores.mailStore);
		case "arch-review-dispatch":
			return evaluateArchReviewDispatch(mission, stores.mailStore);
		case "arch-review":
			return evaluateArchReviewComplete(mission, stores.mailStore);
		case "await-refactor":
			return evaluateRefactorCompletion(mission, stores.mailStore);
		case "await-arch-final":
			return evaluateArchFinal(mission, stores.mailStore);
		case "summary":
			return evaluateSummaryReady(mission, artifactRoot);
		case "await-leads-done":
			return evaluateAwaitLeadsDone(mission, stores.mailStore);
		case "review":
			return evaluatePlanReviewComplete(mission, stores.mailStore);
		case "review-stuck":
			return evaluateReviewStuck(mission, stores.mailStore);
		case "collect-verdicts":
			return evaluateCollectVerdicts(mission, stores.mailStore);
		case "frozen":
			// Human gates are resolved by ov mission answer, not by evaluators.
			// Return met:false without unknown flag to suppress missing-evaluator warnings.
			return { met: false };
		default:
			return { met: false, unknown: true };
	}
}

/** Direct-tier gate: check coordinator inbox for merge_ready from leads. */
function evaluateAwaitLeadsDone(mission: Mission, mailStore: MailStore | null): GateEvalResult {
	if (!mailStore) return { met: false };
	// Coordinator name is slug-scoped or bare
	const coordName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";
	const msgs = mailStore.getAll({ to: coordName });
	const mergeReady = msgs.find((m) => m.type === "merge_ready");
	if (mergeReady) {
		return {
			met: true,
			trigger: "lead_done",
		};
	}
	return {
		met: false,
		nudgeTarget: coordName,
		nudgeMessage: "Waiting for lead merge_ready signal. Check lead status.",
	};
}

/** Plan-phase review gate: check if plan review converged with APPROVE verdict. */
function evaluatePlanReviewComplete(
	mission: Mission,
	mailStore: MailStore | null,
): GateEvalResult {
	if (!mailStore) return { met: false };
	const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
	const msgs = mailStore.getAll({ to: analystName });
	const approved = msgs.find(
		(m) =>
			m.type === "plan_review_consolidated" &&
			(m.subject?.toLowerCase().includes("approve") ?? false),
	);
	if (approved) {
		return { met: true, trigger: "approved" };
	}
	const stuck = msgs.find(
		(m) =>
			m.type === "plan_review_consolidated" &&
			(m.subject?.toLowerCase().includes("stuck") ?? false),
	);
	if (stuck) {
		return { met: true, trigger: "stuck" };
	}
	return { met: false };
}

/** Plan-phase review-stuck gate: check if stuck review was resolved. */
function evaluateReviewStuck(
	mission: Mission,
	mailStore: MailStore | null,
): GateEvalResult {
	if (!mailStore) return { met: false };
	if (mission.phase !== "plan") {
		return { met: true, trigger: "override" };
	}
	return { met: false };
}

/** Review cell collect-verdicts gate: check if any critic verdicts arrived. */
function evaluateCollectVerdicts(
	mission: Mission,
	mailStore: MailStore | null,
): GateEvalResult {
	if (!mailStore) return { met: false };
	const reviewLeadMsgs = mailStore.getAll({ to: "plan-review-lead" });
	const hasVerdicts = reviewLeadMsgs.some((m) => m.type === "plan_critic_verdict");
	if (hasVerdicts) {
		return { met: true, trigger: "verdicts_collected" };
	}
	return { met: false };
}
