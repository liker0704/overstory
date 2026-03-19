/**
 * Spec analyzer — deterministic scoring of task spec markdown files.
 */

import { computeOverallScore, scorePresence } from "../dimensions.ts";
import type { DimensionScore, InsertReviewRecord } from "../types.ts";

export interface SpecReviewInput {
	specPath: string;
	content: string;
}

function hasSection(content: string, ...patterns: RegExp[]): boolean {
	return patterns.some((p) => p.test(content));
}

export function analyzeSpec(input: SpecReviewInput): InsertReviewRecord {
	const { specPath, content } = input;

	const hasObjective = hasSection(content, /^#{1,3}\s*objective/im);
	const hasAcceptance = hasSection(content, /^#{1,3}\s*(acceptance criteria|criteria)/im);
	const hasFiles = hasSection(content, /^#{1,3}\s*files/im);
	const hasScope = hasSection(content, /^#{1,3}\s*(scope|file scope)/im);
	const hasContext = hasSection(content, /^#{1,3}\s*context/im);
	const hasDependencies = hasSection(content, /^#{1,3}\s*dependencies/im);

	// clarity: has objective section, concrete language (file paths, function names)
	const hasConcrete = /src\/|\.ts\b|\.json\b|`[^`]+`|\/[a-z]/.test(content);
	const clarityScore = scorePresence((hasObjective ? 1 : 0) + (hasConcrete ? 1 : 0), 2);
	const clarityDetails = `objective section: ${hasObjective}, concrete refs: ${hasConcrete}`;

	// actionability: has acceptance criteria, file scope
	const hasFileScope = hasFiles || hasScope;
	const actionabilityScore = scorePresence((hasAcceptance ? 1 : 0) + (hasFileScope ? 1 : 0), 2);
	const actionabilityDetails = `acceptance criteria: ${hasAcceptance}, file scope: ${hasFileScope}`;

	// completeness: presence of key sections (objective + criteria + scope + context)
	const completenessScore = scorePresence(
		(hasObjective ? 1 : 0) +
			(hasAcceptance ? 1 : 0) +
			(hasFileScope ? 1 : 0) +
			(hasContext ? 1 : 0),
		4,
	);
	const completenessDetails = `objective: ${hasObjective}, criteria: ${hasAcceptance}, scope: ${hasFileScope}, context: ${hasContext}`;

	// signal-to-noise: content vs boilerplate ratio
	const lineCount = content.split("\n").length;
	const codeBlockMatches = content.match(/```/g);
	const codeBlockCount = codeBlockMatches !== null ? Math.floor(codeBlockMatches.length / 2) : 0;
	const bulletMatches = content.match(/^[\s]*[-*]/gm);
	const bulletCount = bulletMatches !== null ? bulletMatches.length : 0;
	const signalLines = codeBlockCount * 3 + bulletCount;
	const signalNoiseScore =
		lineCount > 5 ? Math.min(100, Math.round((signalLines / lineCount) * 200)) : 20;
	const signalNoiseDetails = `${lineCount} lines, ${codeBlockCount} code blocks, ${bulletCount} bullets`;

	// correctness-confidence: references .ts/.js files
	const hasTsRefs = /\.[tj]s\b/.test(content);
	const correctnessScore = hasTsRefs ? 80 : 40;
	const correctnessDetails = `TypeScript/JavaScript file references: ${hasTsRefs}`;

	// coordination-fit: has dependencies section
	const coordinationScore = hasDependencies ? 100 : 40;
	const coordinationDetails = `dependencies section: ${hasDependencies}`;

	const dimensions: DimensionScore[] = [
		{ dimension: "clarity", score: clarityScore, details: clarityDetails },
		{ dimension: "actionability", score: actionabilityScore, details: actionabilityDetails },
		{ dimension: "completeness", score: completenessScore, details: completenessDetails },
		{ dimension: "signal-to-noise", score: signalNoiseScore, details: signalNoiseDetails },
		{
			dimension: "correctness-confidence",
			score: correctnessScore,
			details: correctnessDetails,
		},
		{ dimension: "coordination-fit", score: coordinationScore, details: coordinationDetails },
	];

	return {
		subjectType: "spec",
		subjectId: specPath,
		dimensions,
		overallScore: computeOverallScore(dimensions),
		notes: [],
		reviewerSource: "deterministic",
	};
}
