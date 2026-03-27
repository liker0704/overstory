import { OverstoryError } from "../errors.ts";
import {
	type Architecture,
	type ArchitectureComponent,
	type ArchitectureDecision,
	type ArchitectureInterface,
	type ArchitectureTddAssignment,
	TDD_MODES,
	type TddMode,
} from "./types.ts";

// === Error ===

export class ArchitectureParseError extends OverstoryError {
	readonly filePath: string;

	constructor(message: string, context: { filePath: string; cause?: Error }) {
		super(message, "ARCHITECTURE_PARSE_ERROR", { cause: context.cause });
		this.name = "ArchitectureParseError";
		this.filePath = context.filePath;
	}
}

// === Validation types ===

export interface ArchitectureValidationError {
	path: string;
	message: string;
}

export interface ArchitectureValidationResult {
	valid: boolean;
	errors: ArchitectureValidationError[];
}

// === Helpers ===

function splitSections(content: string): Map<string, string> {
	const sections = new Map<string, string>();
	const parts = content.split(/^(?=## )/m);
	for (const part of parts) {
		const match = part.match(/^## ([^\n]+)\n?([\s\S]*)/);
		if (!match) continue;
		const heading = (match[1] ?? "").trim().toLowerCase();
		const body = (match[2] ?? "").trim();
		sections.set(heading, body);
	}
	return sections;
}

function parseTableRows(content: string, headerPattern: RegExp): string[][] {
	const rows: string[][] = [];
	const lines = content.split("\n");
	let headerIdx = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (headerPattern.test(line)) {
			headerIdx = i;
			break;
		}
	}

	if (headerIdx === -1) return rows;

	for (let i = headerIdx + 2; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (!line.startsWith("|")) break;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((c) => c.trim());
		if (cells.length > 0) rows.push(cells);
	}

	return rows;
}

// === Section parsers ===

function parseComponentsSection(content: string): ArchitectureComponent[] {
	const components: ArchitectureComponent[] = [];
	const rows = parseTableRows(content, /\|\s*Action\s*\|/i);
	for (const cells of rows) {
		if (cells.length < 4) continue;
		const action = cells[0] ?? "";
		const file = (cells[1] ?? "").replace(/`/g, "").trim();
		const purpose = cells[2] ?? "";
		const workstream = cells[3] ?? "";
		components.push({ action, file, purpose, workstream });
	}
	return components;
}

function parseInterfaceBody(body: string): {
	confidence: "High" | "Medium" | "Low" | undefined;
	signatures: string;
	behavior: string;
	invariants: string[];
	errorCases: string[];
} {
	const lines = body.split("\n");
	let confidence: "High" | "Medium" | "Low" | undefined;
	let signatures = "";
	let behavior = "";
	const invariants: string[] = [];
	const errorCases: string[] = [];
	let state: "none" | "signatures" | "invariants" | "errorcases" = "none";
	const sigLines: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		if (trimmed.startsWith("```typescript")) {
			state = "signatures";
			continue;
		}
		if (trimmed === "```" && state === "signatures") {
			state = "none";
			signatures = sigLines.join("\n").trim();
			continue;
		}
		if (state === "signatures") {
			sigLines.push(line);
			continue;
		}

		const confMatch = trimmed.match(/^\*\*Confidence:\*\*\s*(High|Medium|Low)/i);
		if (confMatch) {
			const val = confMatch[1];
			if (val === "High" || val === "Medium" || val === "Low") confidence = val;
			state = "none";
			continue;
		}

		const behaviorMatch = trimmed.match(/^\*\*Behavior:\*\*\s*(.*)/);
		if (behaviorMatch) {
			behavior = (behaviorMatch[1] ?? "").trim();
			state = "none";
			continue;
		}

		if (/^\*\*Invariants:\*\*/.test(trimmed)) {
			state = "invariants";
			continue;
		}

		if (/^\*\*Error cases:\*\*/.test(trimmed)) {
			state = "errorcases";
			continue;
		}

		if (/^\*\*[^*]+:\*\*/.test(trimmed)) {
			state = "none";
			continue;
		}

		if (state === "invariants") {
			const m = trimmed.match(/^[-*]\s+(.+)$/);
			if (m) invariants.push((m[1] ?? "").trim());
		} else if (state === "errorcases") {
			const m = trimmed.match(/^[-*]\s+(.+)$/);
			if (m) errorCases.push((m[1] ?? "").trim());
		}
	}

	return { confidence, signatures, behavior, invariants, errorCases };
}

function parseInterfacesSection(content: string): ArchitectureInterface[] {
	const interfaces: ArchitectureInterface[] = [];
	const blocks = content.split(/^(?=### )/m);

	for (const block of blocks) {
		const headingMatch = block.match(/^### ([^\n]+)\n?([\s\S]*)/);
		if (!headingMatch) continue;
		const headingText = (headingMatch[1] ?? "").trim();
		const body = headingMatch[2] ?? "";

		let name: string;
		let workstream: string;
		const withParens = headingText.match(/^(.+?)\s*\(([^)]+)\)$/);
		if (withParens) {
			name = (withParens[1] ?? "").trim();
			workstream = (withParens[2] ?? "").trim();
		} else {
			name = headingText;
			workstream = headingText;
		}

		const { confidence, signatures, behavior, invariants, errorCases } = parseInterfaceBody(body);
		interfaces.push({ name, workstream, confidence, signatures, behavior, invariants, errorCases });
	}

	return interfaces;
}

function parseTddAssignmentsSection(content: string): ArchitectureTddAssignment[] {
	const assignments: ArchitectureTddAssignment[] = [];
	const rows = parseTableRows(content, /\|\s*Workstream\s*\|/i);
	for (const cells of rows) {
		if (cells.length < 3) continue;
		const workstreamId = cells[0] ?? "";
		const rawMode = (cells[1] ?? "").toLowerCase().trim();
		const rationale = cells[2] ?? "";
		const tddMode: TddMode = (TDD_MODES as readonly string[]).includes(rawMode)
			? (rawMode as TddMode)
			: "skip";
		assignments.push({ workstreamId, tddMode, rationale });
	}
	return assignments;
}

function parseDecisionBody(body: string): {
	chosen: string;
	confidence: "High" | "Medium" | "Low";
	rejected: Array<{ option: string; reason: string }>;
} {
	const lines = body.split("\n");
	let chosen = "";
	let confidence: "High" | "Medium" | "Low" = "Medium";
	const rejected: Array<{ option: string; reason: string }> = [];
	let state: "none" | "rejected" = "none";

	for (const line of lines) {
		const trimmed = line.trim();

		const chosenMatch = trimmed.match(/^\*\*Chosen:\*\*\s*(.*)/);
		if (chosenMatch) {
			chosen = (chosenMatch[1] ?? "").trim();
			state = "none";
			continue;
		}

		const confMatch = trimmed.match(/^\*\*Confidence:\*\*\s*(High|Medium|Low)/i);
		if (confMatch) {
			const val = confMatch[1];
			if (val === "High" || val === "Medium" || val === "Low") confidence = val;
			state = "none";
			continue;
		}

		if (/^\*\*Rejected:\*\*/.test(trimmed)) {
			state = "rejected";
			continue;
		}

		if (/^\*\*[^*]+:\*\*/.test(trimmed)) {
			state = "none";
			continue;
		}

		if (state === "rejected") {
			const m = trimmed.match(/^[-*]\s+(.+)$/);
			if (!m) continue;
			const item = (m[1] ?? "").trim();
			const splitMatch = item.match(/^(.+?)\s*(?:—|-)\s+(.+)$/);
			if (splitMatch) {
				rejected.push({
					option: (splitMatch[1] ?? "").trim(),
					reason: (splitMatch[2] ?? "").trim(),
				});
			} else {
				rejected.push({ option: item, reason: "" });
			}
		}
	}

	return { chosen, confidence, rejected };
}

function parseDecisionsSection(content: string): ArchitectureDecision[] {
	const decisions: ArchitectureDecision[] = [];
	const blocks = content.split(/^(?=### )/m);

	for (const block of blocks) {
		const headingMatch = block.match(/^### (D-\d+):\s*([^\n]*)\n?([\s\S]*)/);
		if (!headingMatch) continue;
		const id = (headingMatch[1] ?? "").trim();
		const body = headingMatch[3] ?? "";

		const { chosen, confidence, rejected } = parseDecisionBody(body);
		decisions.push({ id, chosen, confidence, rejected });
	}

	return decisions;
}

function parseConstraintsSection(content: string): {
	boundaries: string[];
	patterns: string[];
	prohibitions: string[];
} {
	const result = {
		boundaries: [] as string[],
		patterns: [] as string[],
		prohibitions: [] as string[],
	};

	const subsections = content.split(/^(?=### )/m);
	for (const sub of subsections) {
		const headingMatch = sub.match(/^### ([^\n]+)\n?([\s\S]*)/);
		if (!headingMatch) continue;
		const heading = (headingMatch[1] ?? "").trim().toLowerCase();
		const body = headingMatch[2] ?? "";

		const items: string[] = [];
		for (const line of body.split("\n")) {
			const m = line.trim().match(/^[-*]\s+(.+)$/);
			if (m) items.push((m[1] ?? "").trim());
		}

		if (heading === "boundaries") result.boundaries = items;
		else if (heading === "patterns") result.patterns = items;
		else if (heading === "prohibitions") result.prohibitions = items;
	}

	return result;
}

// === Public API ===

export function parseArchitecture(content: string): Architecture {
	const sections = splitSections(content);

	const context = sections.get("context") ?? "";
	const components = parseComponentsSection(sections.get("components") ?? "");
	const interfaces = parseInterfacesSection(sections.get("interfaces") ?? "");
	const tddAssignments = parseTddAssignmentsSection(sections.get("tdd assignments") ?? "");
	const decisions = parseDecisionsSection(sections.get("key decisions") ?? "");
	const constraints = parseConstraintsSection(sections.get("constraints") ?? "");

	return { context, components, interfaces, tddAssignments, decisions, constraints };
}

export function validateArchitecture(
	arch: Architecture,
	workstreamIds: string[],
): ArchitectureValidationResult {
	const errors: ArchitectureValidationError[] = [];

	if (arch.components.length === 0) {
		errors.push({ path: "components", message: "Must have at least one component" });
	}

	const assignedIds = new Set(arch.tddAssignments.map((a) => a.workstreamId));
	for (const id of workstreamIds) {
		if (!assignedIds.has(id)) {
			errors.push({
				path: "tddAssignments",
				message: `Missing TDD assignment for workstream: ${id}`,
			});
		}
	}

	const interfaceWorkstreams = new Set(arch.interfaces.map((i) => i.workstream));
	for (const assignment of arch.tddAssignments) {
		if (assignment.tddMode === "full" && workstreamIds.includes(assignment.workstreamId)) {
			if (!interfaceWorkstreams.has(assignment.workstreamId)) {
				errors.push({
					path: "interfaces",
					message: `Workstream ${assignment.workstreamId} uses full TDD but has no interfaces defined`,
				});
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

export async function loadArchitecture(filePath: string): Promise<Architecture> {
	let content: string;
	try {
		content = await Bun.file(filePath).text();
	} catch (cause) {
		throw new ArchitectureParseError(`Architecture file not found: ${filePath}`, {
			filePath,
			cause: cause instanceof Error ? cause : undefined,
		});
	}

	if (!content.trim()) {
		throw new ArchitectureParseError(`Architecture file is empty: ${filePath}`, { filePath });
	}

	return parseArchitecture(content);
}
