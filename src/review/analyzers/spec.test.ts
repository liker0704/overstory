import { describe, expect, test } from "bun:test";
import { analyzeSpec, type SpecReviewInput } from "./spec.ts";

const FULL_SPEC = `# Spec: Some Feature

## Objective
Implement X by modifying src/foo.ts and src/bar.ts.

## Files
- src/foo.ts (new)
- src/bar.ts (modified)

## Dependencies
- Types from src/types.ts

## Acceptance Criteria
- Function returns correct result for all inputs
- Tests in src/foo.test.ts pass
- No TypeScript errors

## Context
This builds on existing patterns in src/utils.ts.
`;

const MINIMAL_SPEC = `# Some Feature

Do the thing.
`;

describe("analyzeSpec", () => {
	test("returns InsertReviewRecord with all 6 dimensions", () => {
		const input: SpecReviewInput = { specPath: "specs/foo.md", content: FULL_SPEC };
		const result = analyzeSpec(input);
		expect(result.dimensions).toHaveLength(6);
		const dimNames = result.dimensions.map((d) => d.dimension);
		expect(dimNames).toContain("clarity");
		expect(dimNames).toContain("actionability");
		expect(dimNames).toContain("completeness");
		expect(dimNames).toContain("signal-to-noise");
		expect(dimNames).toContain("correctness-confidence");
		expect(dimNames).toContain("coordination-fit");
	});

	test("subjectType is spec, reviewerSource is deterministic", () => {
		const input: SpecReviewInput = { specPath: "specs/foo.md", content: FULL_SPEC };
		const result = analyzeSpec(input);
		expect(result.subjectType).toBe("spec");
		expect(result.reviewerSource).toBe("deterministic");
	});

	test("subjectId is specPath", () => {
		const specPath = ".overstory/specs/task-001.md";
		const result = analyzeSpec({ specPath, content: FULL_SPEC });
		expect(result.subjectId).toBe(specPath);
	});

	test("spec with acceptance criteria scores higher than minimal spec", () => {
		const fullResult = analyzeSpec({ specPath: "specs/full.md", content: FULL_SPEC });
		const minimalResult = analyzeSpec({ specPath: "specs/min.md", content: MINIMAL_SPEC });
		expect(fullResult.overallScore).toBeGreaterThan(minimalResult.overallScore);
		const fullAction = fullResult.dimensions.find((d) => d.dimension === "actionability")!;
		const minAction = minimalResult.dimensions.find((d) => d.dimension === "actionability")!;
		expect(fullAction.score).toBeGreaterThan(minAction.score);
	});

	test("spec with dependencies section scores higher coordination-fit", () => {
		const withDepsResult = analyzeSpec({ specPath: "specs/full.md", content: FULL_SPEC });
		const noDepsResult = analyzeSpec({ specPath: "specs/min.md", content: MINIMAL_SPEC });
		const withDepsCoord = withDepsResult.dimensions.find(
			(d) => d.dimension === "coordination-fit",
		)!;
		const noDepsCoord = noDepsResult.dimensions.find((d) => d.dimension === "coordination-fit")!;
		expect(withDepsCoord.score).toBeGreaterThan(noDepsCoord.score);
	});

	test("spec with objective section scores higher clarity than spec without", () => {
		const withObj = `## Objective\nBuild src/foo.ts.\n`;
		const withoutObj = `## Something\nDo stuff.\n`;
		const withResult = analyzeSpec({ specPath: "a.md", content: withObj });
		const withoutResult = analyzeSpec({ specPath: "b.md", content: withoutObj });
		const withClarity = withResult.dimensions.find((d) => d.dimension === "clarity")!;
		const withoutClarity = withoutResult.dimensions.find((d) => d.dimension === "clarity")!;
		expect(withClarity.score).toBeGreaterThan(withoutClarity.score);
	});

	test("spec referencing .ts files scores higher correctness-confidence", () => {
		const withTsRef = `Some feature\nSee src/foo.ts for details.\n`;
		const withoutTsRef = `Some feature\nDo some stuff somewhere.\n`;
		const withResult = analyzeSpec({ specPath: "a.md", content: withTsRef });
		const withoutResult = analyzeSpec({ specPath: "b.md", content: withoutTsRef });
		const withCC = withResult.dimensions.find((d) => d.dimension === "correctness-confidence")!;
		const withoutCC = withoutResult.dimensions.find(
			(d) => d.dimension === "correctness-confidence",
		)!;
		expect(withCC.score).toBeGreaterThan(withoutCC.score);
	});

	test("empty spec scores zero on all dimensions relying on presence", () => {
		const result = analyzeSpec({ specPath: "empty.md", content: "" });
		expect(result.overallScore).toBeGreaterThanOrEqual(0);
		expect(result.overallScore).toBeLessThanOrEqual(100);
		const completeness = result.dimensions.find((d) => d.dimension === "completeness")!;
		expect(completeness.score).toBe(0);
	});

	test("full spec scores higher completeness than minimal spec", () => {
		const fullResult = analyzeSpec({ specPath: "full.md", content: FULL_SPEC });
		const minResult = analyzeSpec({ specPath: "min.md", content: MINIMAL_SPEC });
		const fullComp = fullResult.dimensions.find((d) => d.dimension === "completeness")!;
		const minComp = minResult.dimensions.find((d) => d.dimension === "completeness")!;
		expect(fullComp.score).toBeGreaterThan(minComp.score);
	});

	test("overallScore is in range 0-100 for any input", () => {
		for (const content of [FULL_SPEC, MINIMAL_SPEC, "", "# Just a title\n"]) {
			const result = analyzeSpec({ specPath: "test.md", content });
			expect(result.overallScore).toBeGreaterThanOrEqual(0);
			expect(result.overallScore).toBeLessThanOrEqual(100);
		}
	});
});
