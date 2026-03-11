import { describe, expect, test } from "bun:test";
import type { AgentSession, SessionCheckpoint } from "../../types.ts";
import { analyzeSession, type SessionReviewInput } from "./session.ts";

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "sess-001",
		agentName: "test-builder",
		capability: "builder",
		runtime: "claude",
		worktreePath: "/tmp/test",
		branchName: "test/branch",
		taskId: "task-001",
		tmuxSession: "test-builder",
		state: "completed",
		pid: 1234,
		parentAgent: null,
		depth: 0,
		runId: null,
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		...overrides,
	};
}

function makeCheckpoint(overrides: Partial<SessionCheckpoint> = {}): SessionCheckpoint {
	return {
		agentName: "test-builder",
		taskId: "task-001",
		sessionId: "sess-001",
		timestamp: new Date().toISOString(),
		progressSummary: "Implemented the feature with proper tests in src/foo.test.ts.",
		filesModified: ["src/foo.ts", "src/foo.test.ts"],
		currentBranch: "test/branch",
		pendingWork: "Update src/bar.ts with new interface",
		mulchDomains: ["typescript"],
		...overrides,
	};
}

describe("analyzeSession", () => {
	test("returns InsertReviewRecord with all 6 dimensions", () => {
		const input: SessionReviewInput = {
			session: makeSession(),
			checkpoint: makeCheckpoint(),
			eventCount: 50,
			errorCount: 2,
			nudgeCount: 1,
			mailSent: 1,
			mailReceived: 0,
			durationMs: 60000,
		};
		const result = analyzeSession(input);
		expect(result.dimensions).toHaveLength(6);
		const dimNames = result.dimensions.map((d) => d.dimension);
		expect(dimNames).toContain("clarity");
		expect(dimNames).toContain("actionability");
		expect(dimNames).toContain("completeness");
		expect(dimNames).toContain("signal-to-noise");
		expect(dimNames).toContain("correctness-confidence");
		expect(dimNames).toContain("coordination-fit");
	});

	test("subjectType is session, reviewerSource is deterministic", () => {
		const input: SessionReviewInput = {
			session: makeSession(),
			checkpoint: makeCheckpoint(),
			eventCount: 10,
			errorCount: 0,
			nudgeCount: 0,
			mailSent: 1,
			mailReceived: 0,
			durationMs: 30000,
		};
		const result = analyzeSession(input);
		expect(result.subjectType).toBe("session");
		expect(result.reviewerSource).toBe("deterministic");
		expect(result.subjectId).toBe("test-builder");
	});

	test("scores completed sessions higher than crashed sessions", () => {
		const completedInput: SessionReviewInput = {
			session: makeSession({ state: "completed" }),
			checkpoint: makeCheckpoint(),
			eventCount: 50,
			errorCount: 1,
			nudgeCount: 1,
			mailSent: 1,
			mailReceived: 0,
			durationMs: 60000,
		};
		const crashedInput: SessionReviewInput = {
			session: makeSession({ state: "zombie" }),
			checkpoint: null,
			eventCount: 10,
			errorCount: 8,
			nudgeCount: 5,
			mailSent: 0,
			mailReceived: 0,
			durationMs: 10000,
		};
		const completedResult = analyzeSession(completedInput);
		const crashedResult = analyzeSession(crashedInput);
		expect(completedResult.overallScore).toBeGreaterThan(crashedResult.overallScore);
	});

	test("session with no checkpoint scores zero on clarity and actionability", () => {
		const input: SessionReviewInput = {
			session: makeSession(),
			checkpoint: null,
			eventCount: 20,
			errorCount: 2,
			nudgeCount: 0,
			mailSent: 1,
			mailReceived: 0,
			durationMs: 30000,
		};
		const result = analyzeSession(input);
		const clarity = result.dimensions.find((d) => d.dimension === "clarity")!;
		const actionability = result.dimensions.find((d) => d.dimension === "actionability")!;
		expect(clarity.score).toBe(0);
		expect(actionability.score).toBe(0);
	});

	test("penalizes nudgeCount > 3 in signal-to-noise", () => {
		const lowNudgeInput: SessionReviewInput = {
			session: makeSession(),
			checkpoint: makeCheckpoint(),
			eventCount: 50,
			errorCount: 0,
			nudgeCount: 1,
			mailSent: 1,
			mailReceived: 0,
			durationMs: 60000,
		};
		const highNudgeInput: SessionReviewInput = {
			session: makeSession(),
			checkpoint: makeCheckpoint(),
			eventCount: 50,
			errorCount: 0,
			nudgeCount: 10,
			mailSent: 1,
			mailReceived: 0,
			durationMs: 60000,
		};
		const lowResult = analyzeSession(lowNudgeInput);
		const highResult = analyzeSession(highNudgeInput);
		const lowSN = lowResult.dimensions.find((d) => d.dimension === "signal-to-noise")!;
		const highSN = highResult.dimensions.find((d) => d.dimension === "signal-to-noise")!;
		expect(lowSN.score).toBeGreaterThan(highSN.score);
	});

	test("zero mail sent scores low coordination-fit", () => {
		const noMailInput: SessionReviewInput = {
			session: makeSession(),
			checkpoint: makeCheckpoint(),
			eventCount: 20,
			errorCount: 0,
			nudgeCount: 0,
			mailSent: 0,
			mailReceived: 0,
			durationMs: 30000,
		};
		const withMailInput: SessionReviewInput = {
			...noMailInput,
			mailSent: 1,
		};
		const noMailResult = analyzeSession(noMailInput);
		const withMailResult = analyzeSession(withMailInput);
		const noMailCoord = noMailResult.dimensions.find((d) => d.dimension === "coordination-fit")!;
		const withMailCoord = withMailResult.dimensions.find(
			(d) => d.dimension === "coordination-fit",
		)!;
		expect(withMailCoord.score).toBeGreaterThan(noMailCoord.score);
	});

	test("high error rate reduces correctness-confidence", () => {
		const lowErrorInput: SessionReviewInput = {
			session: makeSession(),
			checkpoint: makeCheckpoint(),
			eventCount: 100,
			errorCount: 2,
			nudgeCount: 1,
			mailSent: 1,
			mailReceived: 0,
			durationMs: 60000,
		};
		const highErrorInput: SessionReviewInput = {
			...lowErrorInput,
			errorCount: 80,
		};
		const lowResult = analyzeSession(lowErrorInput);
		const highResult = analyzeSession(highErrorInput);
		const lowCC = lowResult.dimensions.find((d) => d.dimension === "correctness-confidence")!;
		const highCC = highResult.dimensions.find((d) => d.dimension === "correctness-confidence")!;
		expect(lowCC.score).toBeGreaterThan(highCC.score);
	});

	test("overallScore is in range 0-100", () => {
		const input: SessionReviewInput = {
			session: makeSession(),
			checkpoint: makeCheckpoint(),
			eventCount: 100,
			errorCount: 50,
			nudgeCount: 8,
			mailSent: 2,
			mailReceived: 1,
			durationMs: 120000,
		};
		const result = analyzeSession(input);
		expect(result.overallScore).toBeGreaterThanOrEqual(0);
		expect(result.overallScore).toBeLessThanOrEqual(100);
	});
});
