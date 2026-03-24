import type { ResearchReport } from "./types.ts";

const VALID_STATUSES = new Set(["running", "completed", "failed", "stopped"]);

export function parseReportFrontmatter(content: string): ResearchReport | null {
	const lines = content.split("\n");
	let start = -1;
	let end = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		if (line.trim() === "---") {
			if (start === -1) {
				start = i;
			} else {
				end = i;
				break;
			}
		}
	}

	if (start === -1 || end === -1) return null;

	const fields: Record<string, string> = {};
	for (let i = start + 1; i < end; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();
		if (value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}

	const topic = fields.topic;
	const slug = fields.slug;
	const status = fields.status;
	const startedAt = fields.startedAt;
	const agentName = fields.agentName;
	const researchersStr = fields.researchers;
	const sourcesCountStr = fields.sourcesCount;

	if (!topic || !slug || !status || !startedAt || !agentName) return null;
	if (!VALID_STATUSES.has(status)) return null;

	const researchers = researchersStr !== undefined ? Number(researchersStr) : 0;
	const sourcesCount = sourcesCountStr !== undefined ? Number(sourcesCountStr) : 0;

	const report: ResearchReport = {
		topic,
		slug,
		status: status as ResearchReport["status"],
		startedAt,
		agentName,
		researchers,
		sourcesCount,
	};

	const completedAt = fields.completedAt;
	if (completedAt) {
		report.completedAt = completedAt;
	}

	return report;
}

export function buildReportFrontmatter(report: ResearchReport): string {
	const lines: string[] = ["---"];
	lines.push(`topic: "${report.topic}"`);
	lines.push(`slug: "${report.slug}"`);
	lines.push(`status: ${report.status}`);
	lines.push(`startedAt: "${report.startedAt}"`);
	if (report.completedAt) {
		lines.push(`completedAt: "${report.completedAt}"`);
	}
	lines.push(`agentName: "${report.agentName}"`);
	lines.push(`researchers: ${report.researchers}`);
	lines.push(`sourcesCount: ${report.sourcesCount}`);
	lines.push("---");
	lines.push("");
	return lines.join("\n");
}

export async function readReport(reportPath: string): Promise<ResearchReport | null> {
	const file = Bun.file(reportPath);
	const exists = await file.exists();
	if (!exists) return null;
	const content = await file.text();
	return parseReportFrontmatter(content);
}

export function formatReportSummary(report: ResearchReport): string {
	const lines: string[] = [
		`Topic:       ${report.topic}`,
		`Slug:        ${report.slug}`,
		`Status:      ${report.status}`,
		`Agent:       ${report.agentName}`,
		`Started:     ${report.startedAt}`,
	];
	if (report.completedAt) {
		lines.push(`Completed:   ${report.completedAt}`);
	}
	lines.push(`Researchers: ${report.researchers}`);
	lines.push(`Sources:     ${report.sourcesCount}`);
	return lines.join("\n");
}
