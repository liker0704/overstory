import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { EvalScenarioError } from "../errors.ts";
import type {
	Assertion,
	AssertionKind,
	ConfigOverrides,
	EvalScenario,
	StartupAction,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Minimal YAML parser for eval scenario files.
 *
 * Supports nested objects, string/number/boolean scalars, quoted strings,
 * block sequences (`- item`), and inline comments. Sufficient for the
 * scenario.yaml and assertions.yaml formats used by eval scenarios.
 */
function parseYaml(text: string): Record<string, unknown> {
	const lines = text.split("\n");
	const root: Record<string, unknown> = {};
	const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
		{ indent: -1, obj: root },
	];

	for (const rawLine of lines) {
		const commentFree = stripComment(rawLine);
		const trimmed = commentFree.trimEnd();
		if (trimmed.trim() === "") continue;

		const indent = countIndent(trimmed);
		const content = trimmed.trim();

		while (stack.length > 1) {
			const top = stack[stack.length - 1];
			if (top && top.indent >= indent) {
				stack.pop();
			} else {
				break;
			}
		}

		const parent = stack[stack.length - 1];
		if (!parent) continue;

		if (content.startsWith("- ")) {
			const value = content.slice(2).trim();
			const objColonIdx = value.indexOf(":");
			const isObjectItem =
				objColonIdx > 0 &&
				!value.startsWith('"') &&
				!value.startsWith("'") &&
				/^[\w-]+$/.test(value.slice(0, objColonIdx).trim());

			if (isObjectItem) {
				const itemKey = value.slice(0, objColonIdx).trim();
				const itemVal = value.slice(objColonIdx + 1).trim();
				const newItem: Record<string, unknown> = {};
				newItem[itemKey] = itemVal !== "" ? parseValue(itemVal) : {};

				const lastKey = findLastKey(parent.obj);
				if (lastKey !== null && Array.isArray(parent.obj[lastKey])) {
					(parent.obj[lastKey] as unknown[]).push(newItem);
					stack.push({ indent, obj: newItem });
					continue;
				}

				if (stack.length >= 2) {
					const grandparent = stack[stack.length - 2];
					if (grandparent) {
						const gpKey = findLastKey(grandparent.obj);
						if (gpKey !== null) {
							const gpVal = grandparent.obj[gpKey];
							if (isEmptyObject(gpVal)) {
								grandparent.obj[gpKey] = [newItem];
								stack.pop();
								stack.push({ indent, obj: newItem });
								continue;
							}
						}
					}
				}
				continue;
			}

			// Scalar array item
			const lastKey = findLastKey(parent.obj);
			if (lastKey !== null && Array.isArray(parent.obj[lastKey])) {
				(parent.obj[lastKey] as unknown[]).push(parseValue(value));
				continue;
			}

			if (stack.length >= 2) {
				const grandparent = stack[stack.length - 2];
				if (grandparent) {
					const gpKey = findLastKey(grandparent.obj);
					if (gpKey !== null && isEmptyObject(grandparent.obj[gpKey])) {
						grandparent.obj[gpKey] = [parseValue(value)];
						stack.pop();
						continue;
					}
				}
			}
			continue;
		}

		const colonIndex = content.indexOf(":");
		if (colonIndex === -1) continue;

		const key = content.slice(0, colonIndex).trim();
		const rawValue = content.slice(colonIndex + 1).trim();

		if (rawValue === "" || rawValue === undefined) {
			const nested: Record<string, unknown> = {};
			parent.obj[key] = nested;
			stack.push({ indent, obj: nested });
		} else if (rawValue === "[]") {
			parent.obj[key] = [];
		} else {
			parent.obj[key] = parseValue(rawValue);
		}
	}

	return root;
}

function isEmptyObject(val: unknown): boolean {
	return (
		val !== null &&
		val !== undefined &&
		typeof val === "object" &&
		!Array.isArray(val) &&
		Object.keys(val as Record<string, unknown>).length === 0
	);
}

function countIndent(line: string): number {
	let count = 0;
	for (const ch of line) {
		if (ch === " ") count++;
		else if (ch === "\t") count += 2;
		else break;
	}
	return count;
}

function stripComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "#" && !inSingle && !inDouble) {
			if (i === 0 || line[i - 1] === " " || line[i - 1] === "\t") {
				return line.slice(0, i);
			}
		}
	}
	return line;
}

function parseValue(raw: string): string | number | boolean | null {
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1);
	}
	if (raw === "true" || raw === "True" || raw === "TRUE") return true;
	if (raw === "false" || raw === "False" || raw === "FALSE") return false;
	if (raw === "null" || raw === "~" || raw === "Null" || raw === "NULL") return null;
	if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
	if (/^-?\d[\d_]*\d$/.test(raw)) return Number.parseInt(raw.replace(/_/g, ""), 10);
	return raw;
}

function findLastKey(obj: Record<string, unknown>): string | null {
	const keys = Object.keys(obj);
	return keys[keys.length - 1] ?? null;
}

const VALID_ASSERTION_KINDS: Set<string> = new Set([
	"min_workers_spawned",
	"no_zombies",
	"merge_queue_empty",
	"tasks_completed",
	"max_stall_rate",
	"max_cost",
	"max_duration_ms",
	"custom",
]);

function parseAssertions(raw: unknown, scenarioPath: string): Assertion[] {
	if (!Array.isArray(raw)) {
		throw new EvalScenarioError("assertions must be a list", { scenarioPath });
	}
	return raw.map((item, i) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new EvalScenarioError(`assertion[${i}] must be an object`, { scenarioPath });
		}
		const obj = item as Record<string, unknown>;
		const kind = obj.kind;
		if (typeof kind !== "string" || !VALID_ASSERTION_KINDS.has(kind)) {
			throw new EvalScenarioError(
				`assertion[${i}].kind must be one of: ${[...VALID_ASSERTION_KINDS].join(", ")}`,
				{ scenarioPath },
			);
		}
		const expected = obj.expected;
		if (expected === undefined || expected === null) {
			throw new EvalScenarioError(`assertion[${i}].expected is required`, { scenarioPath });
		}
		if (
			typeof expected !== "number" &&
			typeof expected !== "boolean" &&
			typeof expected !== "string"
		) {
			throw new EvalScenarioError(`assertion[${i}].expected must be a number, boolean, or string`, {
				scenarioPath,
			});
		}
		const label = obj.label;
		const assertion: Assertion = {
			kind: kind as AssertionKind,
			expected,
		};
		if (typeof label === "string") {
			assertion.label = label;
		}
		return assertion;
	});
}

function parseStartupActions(raw: unknown, scenarioPath: string): StartupAction[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new EvalScenarioError("startup_actions must be a list", { scenarioPath });
	}
	return raw.map((item, i) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new EvalScenarioError(`startup_actions[${i}] must be an object`, { scenarioPath });
		}
		const obj = item as Record<string, unknown>;
		if (typeof obj.command !== "string" || obj.command === "") {
			throw new EvalScenarioError(`startup_actions[${i}].command must be a non-empty string`, {
				scenarioPath,
			});
		}
		const action: StartupAction = { command: obj.command };
		if (typeof obj.description === "string") {
			action.description = obj.description;
		}
		return action;
	});
}

/**
 * Load a scenario from disk.
 *
 * Expects:
 *   <scenarioPath>/scenario.yaml     — required
 *   <scenarioPath>/assertions.yaml   — required
 *   <scenarioPath>/repo-template/    — optional
 *
 * @throws EvalScenarioError on missing files, invalid YAML, or missing required fields.
 */
export async function loadScenario(scenarioPath: string): Promise<EvalScenario> {
	const scenarioYamlPath = join(scenarioPath, "scenario.yaml");
	const assertionsYamlPath = join(scenarioPath, "assertions.yaml");

	const scenarioFile = Bun.file(scenarioYamlPath);
	if (!(await scenarioFile.exists())) {
		throw new EvalScenarioError(`scenario.yaml not found at ${scenarioYamlPath}`, { scenarioPath });
	}

	const assertionsFile = Bun.file(assertionsYamlPath);
	if (!(await assertionsFile.exists())) {
		throw new EvalScenarioError(`assertions.yaml not found at ${assertionsYamlPath}`, {
			scenarioPath,
		});
	}

	let scenarioText: string;
	try {
		scenarioText = await scenarioFile.text();
	} catch (err) {
		throw new EvalScenarioError(`Failed to read scenario.yaml: ${scenarioYamlPath}`, {
			scenarioPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	let assertionsText: string;
	try {
		assertionsText = await assertionsFile.text();
	} catch (err) {
		throw new EvalScenarioError(`Failed to read assertions.yaml: ${assertionsYamlPath}`, {
			scenarioPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	let scenarioParsed: Record<string, unknown>;
	try {
		scenarioParsed = parseYaml(scenarioText);
	} catch (err) {
		throw new EvalScenarioError(`Failed to parse scenario.yaml: ${scenarioYamlPath}`, {
			scenarioPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	let assertionsParsed: Record<string, unknown>;
	try {
		assertionsParsed = parseYaml(assertionsText);
	} catch (err) {
		throw new EvalScenarioError(`Failed to parse assertions.yaml: ${assertionsYamlPath}`, {
			scenarioPath,
			cause: err instanceof Error ? err : undefined,
		});
	}

	const description = scenarioParsed.description;
	if (typeof description !== "string" || description === "") {
		throw new EvalScenarioError("scenario.yaml must have a non-empty 'description' field", {
			scenarioPath,
		});
	}

	const timeoutMs =
		typeof scenarioParsed.timeout_ms === "number" ? scenarioParsed.timeout_ms : DEFAULT_TIMEOUT_MS;

	const configOverrides: ConfigOverrides =
		scenarioParsed.config_overrides !== undefined &&
		scenarioParsed.config_overrides !== null &&
		typeof scenarioParsed.config_overrides === "object" &&
		!Array.isArray(scenarioParsed.config_overrides)
			? (scenarioParsed.config_overrides as ConfigOverrides)
			: {};

	const startupActions = parseStartupActions(scenarioParsed.startup_actions, scenarioPath);
	const assertions = parseAssertions(assertionsParsed.assertions, scenarioPath);

	if (assertions.length === 0) {
		throw new EvalScenarioError("assertions.yaml must contain at least one assertion", {
			scenarioPath,
		});
	}

	const repoTemplateDirPath = join(scenarioPath, "repo-template");
	const repoTemplateExists =
		existsSync(repoTemplateDirPath) && statSync(repoTemplateDirPath).isDirectory();

	const name = scenarioPath.split("/").pop() ?? scenarioPath;

	return {
		name,
		path: scenarioPath,
		description,
		repoTemplatePath: repoTemplateExists ? repoTemplateDirPath : null,
		configOverrides,
		startupActions,
		timeoutMs,
		assertions,
	};
}
