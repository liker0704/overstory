import { describe, expect, test } from "bun:test";
import type { SessionCheckpoint, SessionHandoff } from "../../types.ts";
import { analyzeHandoff, type HandoffReviewInput } from "./handoff.ts";

function makeCheckpoint(overrides: Partial<SessionCheckpoint> = {}): SessionCheckpoint {
	return {
		agentName: "test-builder",
		taskId: "task-001",
		sessionId: "sess-001",
		timestamp: new Date().toISOString(),
		progressSummary: "Implemented the feature. Added tests in src/foo.test.ts.",
		filesModified: ["src/foo.ts", "src/foo.test.ts"],
		currentBranch: "test/branch",
		pendingWork: "Update src/bar.ts with new interface",
		mulchDomains: ["typescript"],
		...overrides,
	};
}

function makeHandoff(
	checkpoint: SessionCheckpoint,
	overrides: Partial<SessionHandoff> = {},
): SessionHandoff {
	return {
		fromSessionId: "sess-001",
		toSessionId: null,
		checkpoint,
		reason: "compaction",
		handoffAt: new Date().toISOString(),
		...overrides,
	};
}

describe("analyzeHandoff", () => {
	test("returns InsertReviewRecord with all 6 dimensions", () => {
		const checkpoint = makeCheckpoint();
		const input: HandoffReviewInput = { handoff: makeHandoff(checkpoint), checkpoint };
		const result = analyzeHandoff(input);
		expect(result.dimensions).toHaveLength(6);
		const dimNames = result.dimensions.map((d) => d.dimension);
		expect(dimNames).toContain("clarity");
		expect(dimNames).toContain("actionability");
		expect(dimNames).toContain("completeness");
		expect(dimNames).toContain("signal-to-noise");
		expect(dimNames).toContain("correctness-confidence");
		expect(dimNames).toContain("coordination-fit");
	});

	test("subjectType is handoff, reviewerSource is deterministic", () => {
		const checkpoint = makeCheckpoint();
		const input: HandoffReviewInput = { handoff: makeHandoff(checkpoint), checkpoint };
		const result = analyzeHandoff(input);
		expect(result.subjectType).toBe("handoff");
		expect(result.reviewerSource).toBe("deterministic");
		expect(result.subjectId).toBe("test-builder");
	});

	test("crash reason scores lower correctness-confidence than compaction", () => {
		const checkpoint = makeCheckpoint();
		const compactionInput: HandoffReviewInput = {
			handoff: makeHandoff(checkpoint, { reason: "compaction" }),
			checkpoint,
		};
		const crashInput: HandoffReviewInput = {
			handoff: makeHandoff(checkpoint, { reason: "crash" }),
			checkpoint,
		};
		const compactionResult = analyzeHandoff(compactionInput);
		const crashResult = analyzeHandoff(crashInput);
		const compactionCC = compactionResult.dimensions.find(
			(d) => d.dimension === "correctness-confidence",
		)!;
		const crashCC = crashResult.dimensions.find((d) => d.dimension === "correctness-confidence")!;
		expect(compactionCC.score).toBeGreaterThan(crashCC.score);
	});

	test("empty pendingWork scores low actionability", () => {
		const goodCheckpoint = makeCheckpoint();
		const emptyCheckpoint = makeCheckpoint({ pendingWork: "" });
		const goodResult = analyzeHandoff({
			handoff: makeHandoff(goodCheckpoint),
			checkpoint: goodCheckpoint,
		});
		const emptyResult = analyzeHandoff({
			handoff: makeHandoff(emptyCheckpoint),
			checkpoint: emptyCheckpoint,
		});
		const goodAction = goodResult.dimensions.find((d) => d.dimension === "actionability")!;
		const emptyAction = emptyResult.dimensions.find((d) => d.dimension === "actionability")!;
		expect(goodAction.score).toBeGreaterThan(emptyAction.score);
	});

	test("pendingWork with file paths scores higher actionability", () => {
		const withPaths = makeCheckpoint({ pendingWork: "Update src/bar.ts and src/types.ts" });
		const withoutPaths = makeCheckpoint({ pendingWork: "Fix the remaining issues and stuff" });
		const withResult = analyzeHandoff({ handoff: makeHandoff(withPaths), checkpoint: withPaths });
		const withoutResult = analyzeHandoff({
			handoff: makeHandoff(withoutPaths),
			checkpoint: withoutPaths,
		});
		const withAction = withResult.dimensions.find((d) => d.dimension === "actionability")!;
		const withoutAction = withoutResult.dimensions.find((d) => d.dimension === "actionability")!;
		expect(withAction.score).toBeGreaterThan(withoutAction.score);
	});

	test("empty progressSummary scores zero signal-to-noise", () => {
		const checkpoint = makeCheckpoint({ progressSummary: "" });
		const input: HandoffReviewInput = { handoff: makeHandoff(checkpoint), checkpoint };
		const result = analyzeHandoff(input);
		const sn = result.dimensions.find((d) => d.dimension === "signal-to-noise")!;
		expect(sn.score).toBe(0);
	});

	test("too-long progressSummary scores lower signal-to-noise than appropriate length", () => {
		const longSummary = "A".repeat(3000);
		const goodSummary = "Implemented the feature. Modified src/foo.ts and src/bar.ts.";
		const longCheckpoint = makeCheckpoint({ progressSummary: longSummary });
		const goodCheckpoint = makeCheckpoint({ progressSummary: goodSummary });
		const longResult = analyzeHandoff({
			handoff: makeHandoff(longCheckpoint),
			checkpoint: longCheckpoint,
		});
		const goodResult = analyzeHandoff({
			handoff: makeHandoff(goodCheckpoint),
			checkpoint: goodCheckpoint,
		});
		const longSN = longResult.dimensions.find((d) => d.dimension === "signal-to-noise")!;
		const goodSN = goodResult.dimensions.find((d) => d.dimension === "signal-to-noise")!;
		expect(goodSN.score).toBeGreaterThan(longSN.score);
	});

	test("missing filesModified and mulchDomains reduces completeness", () => {
		const fullCheckpoint = makeCheckpoint();
		const sparseCheckpoint = makeCheckpoint({ filesModified: [], mulchDomains: [] });
		const fullResult = analyzeHandoff({
			handoff: makeHandoff(fullCheckpoint),
			checkpoint: fullCheckpoint,
		});
		const sparseResult = analyzeHandoff({
			handoff: makeHandoff(sparseCheckpoint),
			checkpoint: sparseCheckpoint,
		});
		const fullComp = fullResult.dimensions.find((d) => d.dimension === "completeness")!;
		const sparseComp = sparseResult.dimensions.find((d) => d.dimension === "completeness")!;
		expect(fullComp.score).toBeGreaterThan(sparseComp.score);
	});

	test("overallScore is in range 0-100", () => {
		const checkpoint = makeCheckpoint();
		const input: HandoffReviewInput = { handoff: makeHandoff(checkpoint), checkpoint };
		const result = analyzeHandoff(input);
		expect(result.overallScore).toBeGreaterThanOrEqual(0);
		expect(result.overallScore).toBeLessThanOrEqual(100);
	});
});
