/** Workflow parser — reads markdown artifacts from a claude-code-workflow task directory. */

import {
	type ParsedWorkflow,
	WORKFLOW_COMPONENT_ACTIONS,
	type WorkflowAcceptanceCriterion,
	type WorkflowComponent,
	type WorkflowMetadata,
	type WorkflowRisk,
	type WorkflowTask,
} from "./types.ts";

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

async function readOptionalFile(path: string): Promise<string | null> {
	try {
		return await Bun.file(path).text();
	} catch {
		return null;
	}
}

// ── parseTaskMetadata ──────────────────────────────────────────────────────────────────────────

/**
 * Parse `task.md` content into WorkflowMetadata.
 * Expects frontmatter fields (Status, Created, Last-updated) before the `# Task: {slug}` header.
 */
export function parseTaskMetadata(content: string): WorkflowMetadata {
	const lines = content.split("\n");

	let slug = "";
	let status = "";
	let created = "";
	let lastUpdated = "";
	const descriptionLines: string[] = [];
	let pastHeader = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (!pastHeader) {
			const headerMatch = trimmed.match(/^#\s+Task:\s*(.+)$/);
			if (headerMatch) {
				slug = (headerMatch[1] ?? "").trim();
				pastHeader = true;
				continue;
			}
			const statusMatch = trimmed.match(/^Status:\s*(.*)$/);
			if (statusMatch) {
				status = (statusMatch[1] ?? "").trim();
				continue;
			}
			const createdMatch = trimmed.match(/^Created:\s*(.*)$/);
			if (createdMatch) {
				created = (createdMatch[1] ?? "").trim();
				continue;
			}
			const updatedMatch = trimmed.match(/^Last-updated:\s*(.*)$/);
			if (updatedMatch) {
				lastUpdated = (updatedMatch[1] ?? "").trim();
			}
		} else {
			descriptionLines.push(line);
		}
	}

	const description = descriptionLines.join("\n").trim();

	return { slug, status, created, lastUpdated, description };
}

// ── parseTaskBreakdown ─────────────────────────────────────────────────────────────────────────

/**
 * Parse `plan/tasks.md` content into an array of WorkflowTask.
 * Sections are delimited by `## task-NN: Title` headings.
 */
export function parseTaskBreakdown(content: string): WorkflowTask[] {
	const taskSectionRegex = /^##\s+(task-\d+):\s+(.+)$/m;
	// Split on task headings, keeping the heading text
	const parts = content.split(/^(?=##\s+task-\d+:)/m);

	const tasks: WorkflowTask[] = [];

	for (const part of parts) {
		const headingMatch = part.match(/^##\s+(task-\d+):\s+(.+)$/m);
		if (!headingMatch) continue;

		const id = (headingMatch[1] ?? "").trim();
		const title = (headingMatch[2] ?? "").trim();

		// Lines after the heading
		const afterHeading = part.slice(part.indexOf("\n") + 1);
		const bodyLines = afterHeading.split("\n");

		let dependencies: string[] = [];
		let tddMode: "full" | "skip" | null = null;
		const descLines: string[] = [];

		for (const line of bodyLines) {
			const trimmed = line.trim();
			const depsMatch = trimmed.match(/^\*\*Dependencies:\*\*\s*(.*)$/);
			if (depsMatch) {
				const raw = (depsMatch[1] ?? "").trim();
				if (raw === "" || raw.toLowerCase() === "none") {
					dependencies = [];
				} else {
					dependencies = raw
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0);
				}
				continue;
			}
			const tddMatch = trimmed.match(/^\*\*TDD:\*\*\s*(.*)$/);
			if (tddMatch) {
				const raw = (tddMatch[1] ?? "").trim().toLowerCase();
				if (raw === "full" || raw === "skip") {
					tddMode = raw;
				} else {
					tddMode = null;
				}
				continue;
			}
			descLines.push(line);
		}

		const description = descLines.join("\n").trim();
		tasks.push({ id, title, description, dependencies, tddMode });
	}

	// Suppress unused variable warning — the regex is used via split above
	void taskSectionRegex;

	return tasks;
}

// ── parseRisks ────────────────────────────────────────────────────────────────────────────────

/**
 * Parse a markdown table with columns `Risk | Likelihood | Impact | Mitigation`.
 * Skips the header row and the separator row.
 */
export function parseRisks(content: string): WorkflowRisk[] {
	const risks: WorkflowRisk[] = [];

	// Find the header row
	const lines = content.split("\n");
	let headerIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/\|\s*Risk\s*\|/i.test(line)) {
			headerIdx = i;
			break;
		}
	}

	if (headerIdx === -1) return risks;

	// Skip header + separator, then parse data rows
	for (let i = headerIdx + 2; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (!line.startsWith("|")) break;

		const cells = line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());

		if (cells.length < 4) continue;

		risks.push({
			risk: cells[0] ?? "",
			likelihood: cells[1] ?? "",
			impact: cells[2] ?? "",
			mitigation: cells[3] ?? "",
		});
	}

	return risks;
}

// ── parseAcceptanceCriteria ────────────────────────────────────────────────────────────────────

/**
 * Parse `plan/acceptance.md` content. Finds `## Definition of Done` section and extracts
 * checkbox items until the next heading.
 */
export function parseAcceptanceCriteria(content: string): WorkflowAcceptanceCriterion[] {
	const criteria: WorkflowAcceptanceCriterion[] = [];
	const lines = content.split("\n");

	let inSection = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (/^##\s+Definition of Done/i.test(trimmed)) {
			inSection = true;
			continue;
		}

		if (inSection) {
			// Stop at next heading
			if (/^#{1,6}\s/.test(trimmed)) break;

			const checkedMatch = trimmed.match(/^-\s+\[x\]\s+(.+)$/i);
			if (checkedMatch) {
				criteria.push({ text: (checkedMatch[1] ?? "").trim(), checked: true });
				continue;
			}
			const uncheckedMatch = trimmed.match(/^-\s+\[ \]\s+(.+)$/);
			if (uncheckedMatch) {
				criteria.push({ text: (uncheckedMatch[1] ?? "").trim(), checked: false });
			}
		}
	}

	return criteria;
}

// ── parseComponents ───────────────────────────────────────────────────────────────────────────

/**
 * Parse a markdown table with columns `Action | Path | Purpose` from architecture.md.
 * Strips backticks from Path values. Skips rows with invalid Action values.
 */
export function parseComponents(content: string): WorkflowComponent[] {
	const components: WorkflowComponent[] = [];
	const lines = content.split("\n");

	let headerIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/\|\s*Action\s*\|/i.test(line)) {
			headerIdx = i;
			break;
		}
	}

	if (headerIdx === -1) return components;

	for (let i = headerIdx + 2; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (!line.startsWith("|")) break;

		const cells = line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());

		if (cells.length < 3) continue;

		const action = (cells[0] ?? "").toUpperCase();
		if (!(WORKFLOW_COMPONENT_ACTIONS as readonly string[]).includes(action)) {
			console.warn(`[parseComponents] Skipping invalid action: ${cells[0]}`);
			continue;
		}

		const path = (cells[1] ?? "").replace(/`/g, "").trim();
		const purpose = (cells[2] ?? "").trim();

		components.push({
			action: action as WorkflowComponent["action"],
			path,
			purpose,
		});
	}

	return components;
}

// ── parseWorkflow ─────────────────────────────────────────────────────────────────────────────

/**
 * Read and parse all files in a claude-code-workflow task directory.
 * Throws if required files are missing.
 */
export async function parseWorkflow(sourcePath: string): Promise<ParsedWorkflow> {
	const join = (rel: string) => `${sourcePath}/${rel}`;

	// Required files
	let taskContent: string;
	try {
		taskContent = await Bun.file(join("task.md")).text();
	} catch {
		throw new Error(
			`Required file missing: task.md. Ensure this is a valid claude-code-workflow task directory.`,
		);
	}

	let tasksContent: string;
	try {
		tasksContent = await Bun.file(join("plan/tasks.md")).text();
	} catch {
		throw new Error(
			`Required file missing: plan/tasks.md. Ensure this is a valid claude-code-workflow task directory.`,
		);
	}

	// Optional files
	const [planRaw, risksRaw, acceptanceRaw, architectureRaw, researchRaw] = await Promise.all([
		readOptionalFile(join("plan/plan.md")),
		readOptionalFile(join("plan/risks.md")),
		readOptionalFile(join("plan/acceptance.md")),
		readOptionalFile(join("architecture.md")),
		readOptionalFile(join("research/_summary.md")),
	]);

	const metadata = parseTaskMetadata(taskContent);
	const tasks = parseTaskBreakdown(tasksContent);
	const risks = risksRaw !== null ? parseRisks(risksRaw) : [];
	const acceptanceCriteria = acceptanceRaw !== null ? parseAcceptanceCriteria(acceptanceRaw) : [];
	const components = architectureRaw !== null ? parseComponents(architectureRaw) : [];

	const planSummary = planRaw !== null ? planRaw.trim() || null : null;
	const researchSummary = researchRaw !== null ? researchRaw.trim() || null : null;
	const architectureContext = architectureRaw !== null ? architectureRaw.trim() || null : null;

	return {
		metadata,
		tasks,
		risks,
		components,
		acceptanceCriteria,
		planSummary,
		researchSummary,
		architectureContext,
	};
}
