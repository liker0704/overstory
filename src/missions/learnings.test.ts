import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildLowScoringDimensionRecords,
	buildMissionSummaryRecord,
	buildWorkstreamPatternRecord,
	parseDecisions,
	readJsonSafe,
	readTextSafe,
} from "./learnings.ts";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "ov-learnings-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("parseDecisions", () => {
	test("parses D-prefixed decisions", () => {
		const content = [
			"# Decisions",
			"",
			"D1: Use stdio transport for MCP communication.",
			"D2: One tool per endpoint, names: gfs_{domain}_{action}.",
			"D3: Minimal dependencies — mcp + httpx only.",
		].join("\n");

		const result = parseDecisions(content);
		expect(result).toHaveLength(3);
		expect(result[0]?.id).toBe("D1");
		expect(result[0]?.text).toBe("Use stdio transport for MCP communication.");
		expect(result[2]?.id).toBe("D3");
	});

	test("returns empty array for no decisions", () => {
		expect(parseDecisions("# Decisions\n\nNone yet.")).toEqual([]);
	});

	test("handles multi-word decisions with special chars", () => {
		const content = "D1: Auth via GFS_API_KEY env var — Bearer token on all requests.";
		const result = parseDecisions(content);
		expect(result).toHaveLength(1);
		expect(result[0]?.text).toContain("GFS_API_KEY");
	});
});

describe("buildMissionSummaryRecord", () => {
	test("builds reference record with agent stats", () => {
		const record = buildMissionSummaryRecord(
			{
				id: "m-1",
				slug: "test-mission",
				objective: "Build a thing",
				state: "completed",
				phase: "done",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-02T00:00:00Z",
				reopenCount: 0,
				runId: "run-1",
			},
			[
				{
					agentName: "builder-1",
					capability: "builder",
					state: "completed",
					startedAt: "",
					lastActivity: "",
				},
				{
					agentName: "scout-1",
					capability: "scout",
					state: "completed",
					startedAt: "",
					lastActivity: "",
				},
			],
			[
				{ agentName: "builder-1", estimatedCostUsd: 1.5, inputTokens: 1000, outputTokens: 500 },
				{ agentName: "scout-1", estimatedCostUsd: 0.5, inputTokens: 500, outputTokens: 200 },
			],
			"test-mission",
		);

		expect(record.type).toBe("reference");
		expect(record.classification).toBe("foundational");
		expect(record.outcomeStatus).toBe("success");
		expect(record.description).toContain("Agents: 2");
		expect(record.description).toContain("builder, scout");
		expect(record.description).toContain("$2.00");
	});

	test("marks failed missions with failure outcome", () => {
		const record = buildMissionSummaryRecord(
			{
				id: "m-2",
				slug: "fail",
				objective: "X",
				state: "stopped",
				phase: "execute",
				createdAt: "",
				updatedAt: "",
				reopenCount: 0,
				runId: null,
			},
			[],
			[],
			"fail",
		);
		expect(record.outcomeStatus).toBe("failure");
	});
});

describe("buildLowScoringDimensionRecords", () => {
	test("identifies dimensions below threshold", () => {
		const records = buildLowScoringDimensionRecords(
			{
				dimensions: [
					{ dimension: "clarity", score: 100, details: "good" },
					{ dimension: "completeness", score: 60, details: "missing tests" },
					{ dimension: "coordination-fit", score: 50, details: "too many agents" },
				],
				overallScore: 70,
			},
			"test",
		);

		expect(records).toHaveLength(2);
		expect(records[0]?.description).toContain("60/100");
		expect(records[0]?.description).toContain("completeness");
		expect(records[1]?.description).toContain("50/100");
	});

	test("returns empty for all high scores", () => {
		const records = buildLowScoringDimensionRecords(
			{
				dimensions: [
					{ dimension: "clarity", score: 100, details: "good" },
					{ dimension: "completeness", score: 90, details: "good" },
				],
				overallScore: 95,
			},
			"test",
		);
		expect(records).toHaveLength(0);
	});
});

describe("buildWorkstreamPatternRecord", () => {
	test("builds pattern from workstreams", () => {
		const record = buildWorkstreamPatternRecord(
			[
				{
					id: "ws-core",
					taskId: "t-1",
					objective: "Core",
					fileScope: [],
					dependsOn: [],
					status: "done",
				},
				{
					id: "ws-api",
					taskId: "t-2",
					objective: "API",
					fileScope: [],
					dependsOn: ["ws-core"],
					status: "done",
				},
			],
			[
				{
					agentName: "b-1",
					capability: "builder",
					state: "completed",
					startedAt: "",
					lastActivity: "",
				},
			],
			"test",
		);

		expect(record).not.toBeNull();
		expect(record?.type).toBe("pattern");
		expect(record?.description).toContain("2 workstreams");
		expect(record?.description).toContain("ws-api → ws-core");
	});

	test("returns null for empty workstreams", () => {
		expect(buildWorkstreamPatternRecord([], [], "test")).toBeNull();
	});
});

describe("readJsonSafe / readTextSafe", () => {
	test("reads valid JSON", async () => {
		const path = join(tempDir, "test.json");
		await writeFile(path, '{"key": "value"}');
		const result = readJsonSafe<{ key: string }>(path);
		expect(result?.key).toBe("value");
	});

	test("returns null for missing file", () => {
		expect(readJsonSafe(join(tempDir, "nope.json"))).toBeNull();
	});

	test("returns null for malformed JSON", async () => {
		const path = join(tempDir, "bad.json");
		await writeFile(path, "not json {{{");
		expect(readJsonSafe(path)).toBeNull();
	});

	test("reads text file", async () => {
		const path = join(tempDir, "test.md");
		await writeFile(path, "# Hello\nWorld");
		expect(readTextSafe(path)).toBe("# Hello\nWorld");
	});

	test("returns null for missing text file", () => {
		expect(readTextSafe(join(tempDir, "nope.md"))).toBeNull();
	});
});
