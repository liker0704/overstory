/**
 * Test-plan.yaml parser and validator.
 *
 * Parses `plan/test-plan.yaml` produced by the Architect agent into the
 * `TestPlan` type and validates cross-references against Architecture and
 * workstreams.
 */

import { readFileSync } from "node:fs";
import { parseYaml } from "../config-yaml.ts";
import { OverstoryError } from "../errors.ts";
import {
	type Architecture,
	TDD_MODES,
	type TddMode,
	type TestPlan,
	type TestPlanCase,
	type TestPlanFile,
	type TestPlanSuite,
} from "./types.ts";

// === Error ===

export class TestPlanError extends OverstoryError {
	constructor(message: string, cause?: Error) {
		super(message, "TEST_PLAN_ERROR", { cause });
		this.name = "TestPlanError";
	}
}

// === Validation types ===

export interface ValidationError {
	path: string;
	message: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: ValidationError[];
}

// === Helpers ===

function isObject(val: unknown): val is Record<string, unknown> {
	return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Returns true if `p` is a safe relative path.
 * Rejects: absolute paths, paths containing `..` segments, empty string.
 */
function isSafeRelativePath(p: string): boolean {
	if (p === "") return false;
	if (p.startsWith("/") || p.startsWith("\\")) return false;
	// Split on both slash styles and check each segment
	const segments = p.split(/[\\/]/);
	for (const seg of segments) {
		if (seg === "..") return false;
	}
	return true;
}

// === Parsing ===

function parseCases(raw: unknown, basePath: string): TestPlanCase[] {
	if (!Array.isArray(raw)) {
		throw new TestPlanError(`${basePath}: expected array`);
	}
	return raw.map((item, i) => {
		const path = `${basePath}[${i}]`;
		if (!isObject(item)) throw new TestPlanError(`${path}: expected object`);

		if (typeof item.id !== "string" || item.id.trim() === "") {
			throw new TestPlanError(`${path}.id: expected non-empty string`);
		}
		if (typeof item.description !== "string") {
			throw new TestPlanError(`${path}.description: expected string`);
		}
		const validTypes = ["unit", "integration", "e2e", "regression"] as const;
		if (!validTypes.includes(item.type as (typeof validTypes)[number])) {
			throw new TestPlanError(
				`${path}.type: expected one of ${validTypes.join(", ")}, got ${String(item.type)}`,
			);
		}
		if (typeof item.expectedBehavior !== "string") {
			throw new TestPlanError(`${path}.expectedBehavior: expected string`);
		}
		return {
			id: item.id as string,
			description: item.description as string,
			type: item.type as TestPlanCase["type"],
			expectedBehavior: item.expectedBehavior as string,
		};
	});
}

function parseFiles(raw: unknown, basePath: string): TestPlanFile[] {
	if (!Array.isArray(raw)) {
		throw new TestPlanError(`${basePath}: expected array`);
	}
	return raw.map((item, i) => {
		const path = `${basePath}[${i}]`;
		if (!isObject(item)) throw new TestPlanError(`${path}: expected object`);

		if (typeof item.path !== "string" || item.path.trim() === "") {
			throw new TestPlanError(`${path}.path: expected non-empty string`);
		}
		if (typeof item.description !== "string") {
			throw new TestPlanError(`${path}.description: expected string`);
		}
		if (typeof item.interfaceRef !== "string") {
			throw new TestPlanError(`${path}.interfaceRef: expected string`);
		}
		const cases = parseCases(item.cases ?? [], `${path}.cases`);
		return {
			path: item.path as string,
			description: item.description as string,
			interfaceRef: item.interfaceRef as string,
			cases,
		};
	});
}

function parseSuites(raw: unknown): TestPlanSuite[] {
	if (!Array.isArray(raw)) {
		throw new TestPlanError("suites: expected array");
	}
	return raw.map((item, i) => {
		const path = `suites[${i}]`;
		if (!isObject(item)) throw new TestPlanError(`${path}: expected object`);

		if (typeof item.workstreamId !== "string" || item.workstreamId.trim() === "") {
			throw new TestPlanError(`${path}.workstreamId: expected non-empty string`);
		}
		if (!TDD_MODES.includes(item.tddMode as TddMode)) {
			throw new TestPlanError(
				`${path}.tddMode: expected one of ${TDD_MODES.join(", ")}, got ${String(item.tddMode)}`,
			);
		}
		const files = parseFiles(item.files ?? [], `${path}.files`);
		return {
			workstreamId: item.workstreamId as string,
			tddMode: item.tddMode as TddMode,
			files,
		};
	});
}

/**
 * Parse test-plan.yaml content into TestPlan type.
 * Throws TestPlanError on structural or type errors.
 */
export function parseTestPlan(yamlContent: string): TestPlan {
	let raw: Record<string, unknown>;
	try {
		raw = parseYaml(yamlContent);
	} catch (err) {
		throw new TestPlanError("Failed to parse YAML", err instanceof Error ? err : undefined);
	}

	if (raw.version !== 1) {
		throw new TestPlanError(`version: expected 1, got ${String(raw.version)}`);
	}
	if (typeof raw.missionId !== "string" || raw.missionId.trim() === "") {
		throw new TestPlanError("missionId: expected non-empty string");
	}
	if (typeof raw.architectureRef !== "string" || raw.architectureRef.trim() === "") {
		throw new TestPlanError("architectureRef: expected non-empty string");
	}

	const suites = parseSuites(raw.suites);

	return {
		version: 1,
		missionId: raw.missionId as string,
		architectureRef: raw.architectureRef as string,
		suites,
	};
}

/**
 * Load and parse from a file path synchronously.
 * Throws TestPlanError on read or parse failure.
 */
export function loadTestPlan(filePath: string): TestPlan {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch (err) {
		throw new TestPlanError(
			`Failed to read test-plan file: ${filePath}`,
			err instanceof Error ? err : undefined,
		);
	}
	return parseTestPlan(content);
}

// === Validation ===

/**
 * Validate test-plan against architecture and workstreams.
 *
 * Rules:
 * 1. Every `full` mode suite MUST have at least one file with cases
 * 2. Every `full` mode suite MUST have at least one `e2e` or `integration` case
 * 3. Every workstreamId must exist in workstreamIds
 * 4. Every tddMode must match TDD Assignment in architecture
 * 5. Every interfaceRef must match an interface name in architecture
 * 6. No duplicate case `id` across all suites
 * 7. `light` mode: cases optional
 * 8. `skip` mode: files must be empty
 * 9. Every file.path must be a safe relative path (no `..`, no absolute)
 */
export function validateTestPlan(
	plan: TestPlan,
	architecture: Architecture,
	workstreamIds: string[],
): ValidationResult {
	const errors: ValidationError[] = [];

	const wsIdSet = new Set(workstreamIds);
	const interfaceNames = new Set(architecture.interfaces.map((iface) => iface.name));
	const tddAssignmentMap = new Map(
		architecture.tddAssignments.map((a) => [a.workstreamId, a.tddMode]),
	);

	const seenCaseIds = new Set<string>();

	for (let si = 0; si < plan.suites.length; si++) {
		const suite = plan.suites[si];
		if (!suite) continue;
		const sPath = `suites[${si}]`;

		// Rule 3: workstreamId must exist in workstreamIds
		if (!wsIdSet.has(suite.workstreamId)) {
			errors.push({
				path: `${sPath}.workstreamId`,
				message: `Unknown workstreamId: ${suite.workstreamId}`,
			});
		}

		// Rule 4: tddMode must match architecture TDD assignment
		const assignedMode = tddAssignmentMap.get(suite.workstreamId);
		if (assignedMode !== undefined && assignedMode !== suite.tddMode) {
			errors.push({
				path: `${sPath}.tddMode`,
				message: `tddMode mismatch: plan has ${suite.tddMode}, architecture assigns ${assignedMode} for workstream ${suite.workstreamId}`,
			});
		}

		// Rule 8: skip mode => files must be empty
		if (suite.tddMode === "skip" && suite.files.length > 0) {
			errors.push({
				path: `${sPath}.files`,
				message: `skip mode workstream must have empty files array`,
			});
		}

		// Rule 1: full mode => must have at least one file with cases
		if (suite.tddMode === "full" && suite.files.length === 0) {
			errors.push({
				path: `${sPath}.files`,
				message: `full mode workstream must have at least one test suite with cases`,
			});
		}

		// Collect all cases for rule 2 check
		let hasIntegrationOrE2e = false;

		for (let fi = 0; fi < suite.files.length; fi++) {
			const file = suite.files[fi];
			if (!file) continue;
			const fPath = `${sPath}.files[${fi}]`;

			// Rule 9: safe relative path
			if (!isSafeRelativePath(file.path)) {
				errors.push({
					path: `${fPath}.path`,
					message: `Unsafe file path: ${file.path} — must be a safe relative path with no .. segments or absolute components`,
				});
			}

			// Rule 5: interfaceRef must exist in architecture
			if (file.interfaceRef !== "" && !interfaceNames.has(file.interfaceRef)) {
				errors.push({
					path: `${fPath}.interfaceRef`,
					message: `Unknown interface reference: ${file.interfaceRef}`,
				});
			}

			for (let ci = 0; ci < file.cases.length; ci++) {
				const c = file.cases[ci];
				if (!c) continue;
				const cPath = `${fPath}.cases[${ci}]`;

				// Rule 6: no duplicate case ids
				if (seenCaseIds.has(c.id)) {
					errors.push({
						path: `${cPath}.id`,
						message: `Duplicate case id: ${c.id}`,
					});
				}
				seenCaseIds.add(c.id);

				if (c.type === "e2e" || c.type === "integration") {
					hasIntegrationOrE2e = true;
				}
			}
		}

		// Rule 2: full mode => at least one e2e or integration case
		if (suite.tddMode === "full" && !hasIntegrationOrE2e) {
			errors.push({
				path: `${sPath}`,
				message: `full mode workstream must have at least one e2e or integration case`,
			});
		}
	}

	return { valid: errors.length === 0, errors };
}
