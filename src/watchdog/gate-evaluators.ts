/**
 * Gate evaluators for mission lifecycle engine.
 *
 * Pure functions that check whether an async gate's resolution condition is met.
 * Each evaluator returns whether the condition is met, the trigger to fire,
 * and optionally a nudge target/message if the condition is not met.
 */

import type { MailStore } from "../mail/store.ts";
import type { MissionStore } from "../missions/types.ts";
import type { SessionStore } from "../sessions/store.ts";
import type { Mission } from "../types.ts";

export interface GateEvalResult {
	met: boolean;
	trigger?: string;
	nudgeTarget?: string;
	nudgeMessage?: string;
	unknown?: boolean;
}

/** Check if research phase has completed: analyst sent result mail to coordinator.
 * If all scouts dispatched by analyst have returned results but analyst hasn't
 * aggregated yet, escalate with a specific nudge telling analyst exactly what
 * to do. The scout content lives in analyst's inbox — only analyst can aggregate. */
export function evaluateAwaitResearch(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const analystName = mission.analystSessionId ? `mission-analyst-${mission.slug}` : null;
	if (!analystName) {
		// Analyst spawn may be in progress (tierSetCommand spawns after DB transaction).
		// Suppress nudge — grace period handles timing naturally.
		return { met: false };
	}

	// Path 1: analyst explicitly sent aggregated result to coordinator.
	const coordinatorName = `coordinator-${mission.slug}`;
	const coordInbox = mailStore.getAll({ to: coordinatorName });
	const hasResult = coordInbox.some(
		(m) =>
			m.type === "result" &&
			m.from.includes("analyst") &&
			(!gateEnteredAt || m.createdAt >= gateEnteredAt),
	);
	if (hasResult) {
		return { met: true, trigger: "research_complete" };
	}

	// Path 2: graph-level scout aggregation detection.
	// If analyst dispatched scouts and all replied but analyst didn't aggregate,
	// send a specific nudge (not auto-advance — scout content is in analyst's
	// inbox, only analyst can meaningfully summarize for coordinator).
	// Scope to scout-prefixed recipients; analyst may also dispatch non-scout
	// agents (e.g. plan-review-lead) which must not poison this detection.
	const analystOutbox = mailStore.getAll({ from: analystName });
	const scoutDispatches = analystOutbox.filter(
		(m) =>
			m.type === "dispatch" &&
			m.to.startsWith("scout-") &&
			(!gateEnteredAt || m.createdAt >= gateEnteredAt),
	);
	if (scoutDispatches.length > 0) {
		const analystInbox = mailStore.getAll({ to: analystName });
		const completedCount = scoutDispatches.filter((dispatch) =>
			analystInbox.some(
				(reply) =>
					reply.from === dispatch.to &&
					reply.type === "result" &&
					reply.createdAt >= dispatch.createdAt,
			),
		).length;
		if (completedCount === scoutDispatches.length) {
			return {
				met: false,
				nudgeTarget: analystName,
				nudgeMessage: `All ${scoutDispatches.length} dispatched scouts have returned results. Aggregate their findings and send a result-type mail to ${coordinatorName} now.`,
			};
		}
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
	gateEnteredAt?: string,
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
			(m) =>
				m.type === "result" &&
				m.subject?.toLowerCase().includes("plan complete") &&
				(!gateEnteredAt || m.createdAt >= gateEnteredAt),
		);
		if (planComplete) {
			return { met: true, trigger: "ready" };
		}

		// If analyst has been dispatched for planning, understand phase is complete — advance.
		// The coordinator dispatching planning IS the signal that research has been evaluated.
		const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
		const allMsgs = mailStore.getAll({ to: analystName });
		const planningDispatched = allMsgs.find(
			(m) =>
				m.type === "dispatch" &&
				m.subject?.toLowerCase().includes("planning phase") &&
				(!gateEnteredAt || m.createdAt >= gateEnteredAt),
		);
		if (planningDispatched) {
			return { met: true, trigger: "ready" };
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

/**
 * Check if any workstream in the mission has TDD mode active (full or light).
 * Reads workstreams.json from the mission artifact root.
 */
async function isTddActive(artifactRoot: string): Promise<boolean> {
	try {
		const path = `${artifactRoot}/plan/workstreams.json`;
		const file = Bun.file(path);
		if (!(await file.exists())) return false;
		const content = await file.json();
		const ws = content?.workstreams;
		if (!Array.isArray(ws)) return false;
		return ws.some((w: { tddMode?: string }) => w.tddMode !== undefined && w.tddMode !== "skip");
	} catch {
		return false;
	}
}

/**
 * Check if architect has completed design: architect_ready mail + required files exist.
 * Adapts artifact requirements based on TDD mode:
 *   - TDD active: architecture.md + test-plan.yaml required
 *   - TDD inactive: architecture.md only (no test-plan.yaml)
 */
export async function evaluateArchitectDesign(
	mission: Mission,
	artifactRoot: string,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): Promise<GateEvalResult> {
	if (!mailStore) return { met: false };

	// Guard: architect session must exist before nudging
	if (!mission.architectSessionId) {
		return { met: false };
	}

	const tddActive = await isTddActive(artifactRoot);

	// Required artifact: architecture.md (always)
	const archPath = `${artifactRoot}/plan/architecture.md`;
	const archExists = await Bun.file(archPath).exists();

	if (!archExists) {
		const artifacts = tddActive ? "architecture.md and test-plan.yaml" : "architecture.md";
		return {
			met: false,
			nudgeTarget: `architect-${mission.slug}`,
			nudgeMessage: `Complete ${artifacts}, then send architect_ready`,
		};
	}

	// Conditional artifact: test-plan.yaml (only when TDD active)
	if (tddActive) {
		const testPlanPath = `${artifactRoot}/plan/test-plan.yaml`;
		const testPlanExists = await Bun.file(testPlanPath).exists();
		if (!testPlanExists) {
			return {
				met: false,
				nudgeTarget: `architect-${mission.slug}`,
				nudgeMessage: "architecture.md exists but test-plan.yaml is missing. TDD mode is active.",
			};
		}
	}

	// Check for architect_ready mail
	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = mailStore.getAll({ to: coordinatorName });
	const hasArchitectReady = msgs.some(
		(m) =>
			m.type === "status" &&
			m.subject.includes("architect_ready") &&
			(!gateEnteredAt || m.createdAt >= gateEnteredAt),
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

/**
 * Check if any active workstream has been merged since the gate was entered.
 *
 * Note: `mailStore.getAll` does not support type filtering — the fetch-all + find pattern
 * is intentional and bounded by the store's default limit (1000 messages).
 */
export async function evaluateWsCompletion(
	mission: Mission,
	mailStore: MailStore | null,
	artifactRoot: string,
	missionStore: MissionStore | null,
	gateEnteredAt?: string,
): Promise<GateEvalResult> {
	if (!mailStore) return { met: false };

	const edName = `execution-director-${mission.slug}`;

	// Legacy path (opt-out via env var) — advance on first `merged` mail to ED.
	// Default is the new SSOT path below.
	if (process.env.OVERSTORY_LEGACY_WS_COMPLETION === "true") {
		const msgs = mailStore.getAll({ to: edName });
		const mergedMail = msgs.find(
			(m) => m.type === "merged" && (!gateEnteredAt || m.createdAt >= gateEnteredAt),
		);
		if (mergedMail) {
			return { met: true, trigger: "ws_merged", nudgeMessage: mergedMail.body };
		}
		return { met: false };
	}

	// New SSOT path — consult workstream_status table.
	// 1. Load planned workstream ids (lenient: only need ids, ignore other fields).
	const plannedIds: string[] = [];
	try {
		const wsPath = `${artifactRoot}/plan/workstreams.json`;
		const file = Bun.file(wsPath);
		if (await file.exists()) {
			const parsed = (await file.json()) as { workstreams?: Array<{ id?: string }> };
			for (const ws of parsed.workstreams ?? []) {
				if (typeof ws.id === "string" && ws.id.length > 0) plannedIds.push(ws.id);
			}
		}
	} catch (err) {
		// Malformed workstreams.json is not pre-handoff — it means plan is corrupted.
		// Surface to stderr so watchdog/operator notice; still return met:false so the
		// mission doesn't auto-advance on bad data.
		process.stderr.write(
			`[evaluateWsCompletion] malformed workstreams.json at ${artifactRoot}/plan/workstreams.json: ${String(err)}\n`,
		);
	}

	// 2. Pre-handoff (no plan yet) → not met.
	if (plannedIds.length === 0) return { met: false };

	// 3. Query status table.
	if (missionStore?.areAllWorkstreamsDone(mission.id, plannedIds)) {
		return { met: true, trigger: "ws_merged" };
	}

	// 4. Sticky-flag fallback: if producer has never fired AND at least one
	//    `merged` mail exists, honor the old behavior once — this keeps
	//    pre-PR-2 in-flight missions from hanging if migration v8 backfill
	//    missed them. After the first producer write per mission, this
	//    fallback is permanently disabled.
	if (!mission.hasEmittedWsProducerWrite) {
		const msgs = mailStore.getAll({ to: edName });
		const mergedMail = msgs.find(
			(m) => m.type === "merged" && (!gateEnteredAt || m.createdAt >= gateEnteredAt),
		);
		if (mergedMail) {
			return {
				met: true,
				trigger: "ws_merged",
				nudgeMessage: `[ws_status_not_populated] ${mergedMail.body}`,
			};
		}
	}

	return { met: false };
}

/** Check if architecture_final mail has been received. */
export function evaluateArchFinal(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = mailStore.getAll({ to: coordinatorName });
	const architectName = `architect-${mission.slug}`;
	const hasFinal = msgs.some(
		(m) =>
			m.from.includes(architectName) &&
			(m.subject.includes("architecture_final") ||
				m.subject.includes("Architecture Finalization")) &&
			(!gateEnteredAt || m.createdAt >= gateEnteredAt),
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

/** Check if planning has started — either coordinator dispatched analyst, or
 * analyst self-transitioned (spawned plan-review-lead or delivered the plan). */
export function evaluateDispatchPlanning(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const analystName = `mission-analyst-${mission.slug}`;

	// Path 1: coordinator explicitly dispatched planning to analyst after gate entry.
	const analystInbox = mailStore.getAll({ to: analystName });
	const hasDispatch = analystInbox.some(
		(m) => m.type === "dispatch" && (!gateEnteredAt || m.createdAt >= gateEnteredAt),
	);
	if (hasDispatch) {
		return { met: true, trigger: "planning_started" };
	}

	// Path 2: analyst already in planning — spawned plan-review-lead or delivered
	// a plan-complete result. No explicit coordinator dispatch is needed when
	// the analyst auto-transitions after research. gateEnteredAt filter deliberately
	// skipped: if these signals exist at all, planning is underway.
	// Subject match is strict ("plan complete" prefix) to avoid false-positive
	// advances on noisy subjects like "Plan obsolete" or "Planning canceled".
	const analystOutbox = mailStore.getAll({ from: analystName });
	const planningActive = analystOutbox.some(
		(m) =>
			m.to === "plan-review-lead" ||
			(m.type === "result" && (m.subject ?? "").toLowerCase().startsWith("plan complete")),
	);
	if (planningActive) {
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
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const architectName = `architect-${mission.slug}`;
	const msgs = mailStore.getAll({ to: architectName });
	const hasDispatch = msgs.some(
		(m) =>
			m.type === "dispatch" &&
			m.subject.toLowerCase().includes("architecture review") &&
			(!gateEnteredAt || m.createdAt >= gateEnteredAt),
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
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const edName = `execution-director-${mission.slug}`;
	const msgs = mailStore.getAll({ to: edName });
	const hasDone = msgs.some(
		(m) =>
			(m.type === "worker_done" || m.type === "merged") &&
			(!gateEnteredAt || m.createdAt >= gateEnteredAt),
	);
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
		nudgeMessage: `[DONE PHASE] Write final mission summary to ${artifactRoot}/results/summary.md. Cover: objective, outcomes, shipped workstreams, known issues. Verify mission.phase === "done" before writing.`,
	};
}

/** Check if architecture review has completed (approved or stuck). */
export function evaluateArchReviewComplete(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };

	const coordinatorName = `coordinator-${mission.slug}`;
	const msgs = mailStore.getAll({ to: coordinatorName });

	// Check for architecture review completion signals
	const hasApproved = msgs.some(
		(m) =>
			m.subject.toLowerCase().includes("architecture review") &&
			(m.type === "result" || m.subject.toLowerCase().includes("approved")) &&
			(!gateEnteredAt || m.createdAt >= gateEnteredAt),
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
		missionStore?: MissionStore | null;
	},
	artifactRoot: string,
	gateEnteredAt?: string,
): Promise<GateEvalResult> {
	// Node IDs follow cellType:nodeName convention
	const parts = nodeId.split(":");
	const nodeName = parts[1];

	switch (nodeName) {
		case "await-research":
			return evaluateAwaitResearch(mission, stores.mailStore, gateEnteredAt);
		case "evaluate":
			return evaluateUnderstandReady(mission, stores.mailStore, gateEnteredAt);
		case "dispatch-planning":
			return evaluateDispatchPlanning(mission, stores.mailStore, gateEnteredAt);
		case "await-plan":
			return evaluateAwaitPlan(mission, artifactRoot);
		case "architect-design":
			return evaluateArchitectDesign(mission, artifactRoot, stores.mailStore, gateEnteredAt);
		case "await-handoff":
			return evaluateAwaitHandoff(mission);
		case "await-ws-completion":
			return evaluateWsCompletion(
				mission,
				stores.mailStore,
				artifactRoot,
				stores.missionStore ?? null,
				gateEnteredAt,
			);
		case "arch-review-dispatch":
			return evaluateArchReviewDispatch(mission, stores.mailStore, gateEnteredAt);
		case "arch-review":
			return evaluateArchReviewComplete(mission, stores.mailStore, gateEnteredAt);
		case "await-refactor":
			return evaluateRefactorCompletion(mission, stores.mailStore, gateEnteredAt);
		case "await-arch-final":
			return evaluateArchFinal(mission, stores.mailStore, gateEnteredAt);
		case "summary":
			return evaluateSummaryReady(mission, artifactRoot);
		case "await-leads-done":
			return evaluateAwaitLeadsDone(mission, stores.mailStore, gateEnteredAt);
		case "review":
			return evaluatePlanReviewComplete(mission, stores.mailStore, gateEnteredAt);
		case "review-stuck":
			return evaluateReviewStuck(mission, stores.mailStore);
		case "collect-verdicts":
			return evaluateCollectVerdicts(mission, stores.mailStore, gateEnteredAt);
		case "frozen":
			// Human gates are resolved by ov mission answer, not by evaluators.
			// Return met:false without unknown flag to suppress missing-evaluator warnings.
			return { met: false };
		default:
			return { met: false, unknown: true };
	}
}

/** Direct-tier gate: check coordinator inbox for merge_ready from leads. */
function evaluateAwaitLeadsDone(
	mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };
	// Coordinator name is slug-scoped or bare
	const coordName = mission.slug ? `coordinator-${mission.slug}` : "coordinator";
	const msgs = mailStore.getAll({ to: coordName });
	const mergeReady = msgs.find(
		(m) => m.type === "merge_ready" && (!gateEnteredAt || m.createdAt >= gateEnteredAt),
	);
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
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };
	const analystName = mission.slug ? `mission-analyst-${mission.slug}` : "mission-analyst";
	const msgs = mailStore.getAll({ to: analystName });
	const approved = msgs.find(
		(m) =>
			m.type === "plan_review_consolidated" &&
			(m.subject?.toLowerCase().includes("approve") ?? false) &&
			(!gateEnteredAt || m.createdAt >= gateEnteredAt),
	);
	if (approved) {
		return { met: true, trigger: "approved" };
	}
	const stuck = msgs.find(
		(m) =>
			m.type === "plan_review_consolidated" &&
			(m.subject?.toLowerCase().includes("stuck") ?? false) &&
			(!gateEnteredAt || m.createdAt >= gateEnteredAt),
	);
	if (stuck) {
		return { met: true, trigger: "stuck" };
	}
	return { met: false };
}

/** Plan-phase review-stuck gate: check if stuck review was resolved. */
function evaluateReviewStuck(mission: Mission, mailStore: MailStore | null): GateEvalResult {
	if (!mailStore) return { met: false };
	if (mission.phase !== "plan") {
		return { met: true, trigger: "override" };
	}
	return { met: false };
}

/** Review cell collect-verdicts gate: check if any critic verdicts arrived. */
function evaluateCollectVerdicts(
	_mission: Mission,
	mailStore: MailStore | null,
	gateEnteredAt?: string,
): GateEvalResult {
	if (!mailStore) return { met: false };
	const reviewLeadMsgs = mailStore.getAll({ to: "plan-review-lead" });
	const hasVerdicts = reviewLeadMsgs.some(
		(m) => m.type === "plan_critic_verdict" && (!gateEnteredAt || m.createdAt >= gateEnteredAt),
	);
	if (hasVerdicts) {
		return { met: true, trigger: "verdicts_collected" };
	}
	return { met: false };
}
