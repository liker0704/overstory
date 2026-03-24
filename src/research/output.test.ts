import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildReportFrontmatter,
	formatReportSummary,
	parseReportFrontmatter,
	readReport,
} from "./output.ts";
import type { ResearchReport } from "./types.ts";

const FULL_REPORT: ResearchReport = {
	topic: "AI safety research",
	slug: "ai-safety-research",
	status: "completed",
	startedAt: "2026-03-24T10:00:00Z",
	completedAt: "2026-03-24T10:15:00Z",
	agentName: "research-ai-safety",
	researchers: 4,
	sourcesCount: 23,
};

const FULL_FRONTMATTER = `---
topic: "AI safety research"
slug: "ai-safety-research"
status: completed
startedAt: "2026-03-24T10:00:00Z"
completedAt: "2026-03-24T10:15:00Z"
agentName: "research-ai-safety"
researchers: 4
sourcesCount: 23
---
`;

describe("parseReportFrontmatter", () => {
	it("parses valid frontmatter with all fields", () => {
		const result = parseReportFrontmatter(FULL_FRONTMATTER);
		expect(result).not.toBeNull();
		expect(result?.topic).toBe("AI safety research");
		expect(result?.slug).toBe("ai-safety-research");
		expect(result?.status).toBe("completed");
		expect(result?.startedAt).toBe("2026-03-24T10:00:00Z");
		expect(result?.completedAt).toBe("2026-03-24T10:15:00Z");
		expect(result?.agentName).toBe("research-ai-safety");
		expect(result?.researchers).toBe(4);
		expect(result?.sourcesCount).toBe(23);
	});

	it("returns null for missing required fields", () => {
		const content = `---
topic: "Missing slug"
status: running
startedAt: "2026-03-24T10:00:00Z"
agentName: "agent"
researchers: 1
sourcesCount: 0
---
`;
		expect(parseReportFrontmatter(content)).toBeNull();
	});

	it("returns null when no frontmatter delimiters", () => {
		expect(parseReportFrontmatter("just some content\nno frontmatter here")).toBeNull();
	});

	it("handles quoted and unquoted values", () => {
		const content = `---
topic: "Quoted topic"
slug: unquoted-slug
status: running
startedAt: "2026-01-01T00:00:00Z"
agentName: "my-agent"
researchers: 2
sourcesCount: 5
---
`;
		const result = parseReportFrontmatter(content);
		expect(result?.topic).toBe("Quoted topic");
		expect(result?.slug).toBe("unquoted-slug");
	});

	it("returns null for invalid status", () => {
		const content = `---
topic: "Test"
slug: "test"
status: invalid-status
startedAt: "2026-01-01T00:00:00Z"
agentName: "agent"
researchers: 1
sourcesCount: 0
---
`;
		expect(parseReportFrontmatter(content)).toBeNull();
	});
});

describe("buildReportFrontmatter", () => {
	it("round-trips with parseReportFrontmatter", () => {
		const built = buildReportFrontmatter(FULL_REPORT);
		const parsed = parseReportFrontmatter(built);
		expect(parsed).not.toBeNull();
		expect(parsed?.topic).toBe(FULL_REPORT.topic);
		expect(parsed?.slug).toBe(FULL_REPORT.slug);
		expect(parsed?.status).toBe(FULL_REPORT.status);
		expect(parsed?.startedAt).toBe(FULL_REPORT.startedAt);
		expect(parsed?.completedAt).toBe(FULL_REPORT.completedAt);
		expect(parsed?.agentName).toBe(FULL_REPORT.agentName);
		expect(parsed?.researchers).toBe(FULL_REPORT.researchers);
		expect(parsed?.sourcesCount).toBe(FULL_REPORT.sourcesCount);
	});

	it("omits completedAt when undefined", () => {
		const report: ResearchReport = { ...FULL_REPORT, completedAt: undefined };
		const built = buildReportFrontmatter(report);
		expect(built).not.toContain("completedAt");
		const parsed = parseReportFrontmatter(built);
		expect(parsed?.completedAt).toBeUndefined();
	});
});

describe("readReport", () => {
	it("returns null for nonexistent file", async () => {
		const result = await readReport("/tmp/nonexistent-report-xyz-123.md");
		expect(result).toBeNull();
	});

	it("parses an existing report file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ov-test-"));
		try {
			const reportPath = join(dir, "report.md");
			await Bun.write(reportPath, `${FULL_FRONTMATTER}\n# Report content\n`);
			const result = await readReport(reportPath);
			expect(result).not.toBeNull();
			expect(result?.topic).toBe("AI safety research");
			expect(result?.status).toBe("completed");
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});

describe("formatReportSummary", () => {
	it("formats all fields when completedAt is present", () => {
		const summary = formatReportSummary(FULL_REPORT);
		expect(summary).toContain("Topic:       AI safety research");
		expect(summary).toContain("Slug:        ai-safety-research");
		expect(summary).toContain("Status:      completed");
		expect(summary).toContain("Agent:       research-ai-safety");
		expect(summary).toContain("Started:     2026-03-24T10:00:00Z");
		expect(summary).toContain("Completed:   2026-03-24T10:15:00Z");
		expect(summary).toContain("Researchers: 4");
		expect(summary).toContain("Sources:     23");
	});

	it("omits Completed line when completedAt is undefined", () => {
		const report: ResearchReport = { ...FULL_REPORT, completedAt: undefined };
		const summary = formatReportSummary(report);
		expect(summary).not.toContain("Completed:");
		expect(summary).toContain("Researchers: 4");
	});
});
