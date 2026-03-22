/**
 * Minimal YAML parser that handles the config structure.
 *
 * Supports:
 * - Nested objects via indentation
 * - String, number, boolean values
 * - Arrays using `- item` syntax
 * - Quoted strings (single and double)
 * - Comments (lines starting with #)
 * - Empty lines
 *
 * Does NOT support:
 * - Flow mappings/sequences ({}, [])
 * - Multi-line strings (|, >)
 * - Anchors/aliases
 * - Tags
 */
export function parseYaml(text: string): Record<string, unknown> {
	const lines = text.split("\n");
	const root: Record<string, unknown> = {};

	// Stack tracks the current nesting context.
	// Each entry: [indent level, parent object, current key for arrays]
	const stack: Array<{
		indent: number;
		obj: Record<string, unknown>;
	}> = [{ indent: -1, obj: root }];

	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		if (rawLine === undefined) continue;

		// Strip comments (but not inside quoted strings)
		const commentFree = stripComment(rawLine);

		// Skip empty lines and comment-only lines
		const trimmed = commentFree.trimEnd();
		if (trimmed.trim() === "") continue;

		const indent = countIndent(trimmed);
		const content = trimmed.trim();

		// Pop stack to find the correct parent for this indent level
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

		// Array item: "- value"
		if (content.startsWith("- ")) {
			const value = content.slice(2).trim();

			// Detect object array item: "- key: val" where key is a plain identifier.
			// Quoted scalars (starting with " or ') are not object items.
			const objColonIdx = value.indexOf(":");
			const isObjectItem =
				objColonIdx > 0 &&
				!value.startsWith('"') &&
				!value.startsWith("'") &&
				/^[\w-]+$/.test(value.slice(0, objColonIdx).trim());

			if (isObjectItem) {
				// Parse the first key:value pair of the new object item.
				const itemKey = value.slice(0, objColonIdx).trim();
				const itemVal = value.slice(objColonIdx + 1).trim();
				const newItem: Record<string, unknown> = {};
				if (itemVal !== "") {
					newItem[itemKey] = parseValue(itemVal);
				} else {
					newItem[itemKey] = {};
				}

				// Find the array this item belongs to and push the new item.
				// Case A: parent.obj already has an array as last value.
				const lastKey = findLastKey(parent.obj);
				if (lastKey !== null) {
					const existing = parent.obj[lastKey];
					if (Array.isArray(existing)) {
						existing.push(newItem);
						stack.push({ indent, obj: newItem });
						continue;
					}
				}

				// Case B: grandparent has an empty {} for this array's key -- convert it.
				if (stack.length >= 2) {
					const grandparent = stack[stack.length - 2];
					if (grandparent) {
						const gpKey = findLastKey(grandparent.obj);
						if (gpKey !== null) {
							const gpVal = grandparent.obj[gpKey];
							if (
								gpVal !== null &&
								gpVal !== undefined &&
								typeof gpVal === "object" &&
								!Array.isArray(gpVal) &&
								Object.keys(gpVal as Record<string, unknown>).length === 0
							) {
								const arr: unknown[] = [newItem];
								grandparent.obj[gpKey] = arr;
								// Pop the now-stale nested {} so the grandparent becomes parent.
								stack.pop();
								stack.push({ indent, obj: newItem });
								continue;
							}
						}
					}
				}
				continue;
			}

			// Scalar array item.
			// Find the key this array belongs to.
			// First check parent.obj directly (for inline arrays or subsequent items).
			const lastKey = findLastKey(parent.obj);
			if (lastKey !== null) {
				const existing = parent.obj[lastKey];
				if (Array.isArray(existing)) {
					existing.push(parseValue(value));
					continue;
				}
			}

			// Multiline array case: `key:\n  - item` pushes an empty {} onto the
			// stack for the nested object.  The `- ` item's parent is that empty {},
			// which has no keys.  We need to look one level up in the stack to find
			// the key whose value is the empty {} and convert it to [].
			if (stack.length >= 2) {
				const grandparent = stack[stack.length - 2];
				if (grandparent) {
					const gpKey = findLastKey(grandparent.obj);
					if (gpKey !== null) {
						const gpVal = grandparent.obj[gpKey];
						if (
							gpVal !== null &&
							gpVal !== undefined &&
							typeof gpVal === "object" &&
							!Array.isArray(gpVal) &&
							Object.keys(gpVal as Record<string, unknown>).length === 0
						) {
							// Convert {} to [] and push the first item.
							const arr: unknown[] = [parseValue(value)];
							grandparent.obj[gpKey] = arr;
							// Pop the now-stale nested {} from the stack so subsequent
							// `- ` items find the grandparent and the array directly.
							stack.pop();
							continue;
						}
					}
				}
			}
			continue;
		}

		// Key: value pair
		const colonIndex = content.indexOf(":");
		if (colonIndex === -1) continue;

		const key = content.slice(0, colonIndex).trim();
		const rawValue = content.slice(colonIndex + 1).trim();

		if (rawValue === "" || rawValue === undefined) {
			// Nested object - create it and push onto stack
			const nested: Record<string, unknown> = {};
			parent.obj[key] = nested;
			stack.push({ indent, obj: nested });
		} else if (rawValue === "[]") {
			// Empty array literal
			parent.obj[key] = [];
		} else {
			parent.obj[key] = parseValue(rawValue);
		}
	}

	return root;
}

/** Count leading spaces (tabs count as 2 spaces for indentation). */
function countIndent(line: string): number {
	let count = 0;
	for (const ch of line) {
		if (ch === " ") count++;
		else if (ch === "\t") count += 2;
		else break;
	}
	return count;
}

/** Strip inline comments that are not inside quoted strings. */
function stripComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "'" && !inDouble) inSingle = !inSingle;
		else if (ch === '"' && !inSingle) inDouble = !inDouble;
		else if (ch === "#" && !inSingle && !inDouble) {
			// Ensure it's preceded by whitespace (YAML spec)
			if (i === 0 || line[i - 1] === " " || line[i - 1] === "\t") {
				return line.slice(0, i);
			}
		}
	}
	return line;
}

/** Parse a scalar YAML value into the appropriate JS type. */
function parseValue(raw: string): string | number | boolean | null {
	// Quoted strings
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1);
	}

	// Booleans
	if (raw === "true" || raw === "True" || raw === "TRUE") return true;
	if (raw === "false" || raw === "False" || raw === "FALSE") return false;

	// Null
	if (raw === "null" || raw === "~" || raw === "Null" || raw === "NULL") return null;

	// Numbers
	if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
	// Underscore-separated numbers (e.g., 30_000)
	if (/^-?\d[\d_]*\d$/.test(raw)) return Number.parseInt(raw.replace(/_/g, ""), 10);

	// Plain string
	return raw;
}

/** Find the last key added to an object (insertion order). */
function findLastKey(obj: Record<string, unknown>): string | null {
	const keys = Object.keys(obj);
	return keys[keys.length - 1] ?? null;
}

// ---- YAML Serialization ----

/**
 * Serialize an OverstoryConfig to YAML format.
 *
 * Handles nested objects with indentation, scalar values,
 * arrays with `- item` syntax, and empty arrays as `[]`.
 */
export function serializeConfigToYaml(config: Record<string, unknown>): string {
	const lines: string[] = [];
	lines.push("# Overstory configuration");
	lines.push("# See: https://github.com/overstory/overstory");
	lines.push("");

	serializeObject(config, lines, 0);

	return `${lines.join("\n")}\n`;
}

/**
 * Recursively serialize an object to YAML lines.
 */
function serializeObject(obj: Record<string, unknown>, lines: string[], depth: number): void {
	const indent = "  ".repeat(depth);

	for (const [key, value] of Object.entries(obj)) {
		if (value === null || value === undefined) {
			lines.push(`${indent}${key}: null`);
		} else if (typeof value === "object" && !Array.isArray(value)) {
			lines.push(`${indent}${key}:`);
			serializeObject(value as Record<string, unknown>, lines, depth + 1);
		} else if (Array.isArray(value)) {
			if (value.length === 0) {
				lines.push(`${indent}${key}: []`);
			} else {
				lines.push(`${indent}${key}:`);
				const itemIndent = "  ".repeat(depth + 1);
				const propIndent = "  ".repeat(depth + 2);
				for (const item of value) {
					if (item !== null && typeof item === "object" && !Array.isArray(item)) {
						// Object array item: "- firstKey: firstVal\n  otherKey: otherVal"
						const entries = Object.entries(item as Record<string, unknown>);
						if (entries.length > 0) {
							const [firstKey, firstVal] = entries[0] ?? [];
							lines.push(`${itemIndent}- ${firstKey}: ${formatYamlValue(firstVal)}`);
							for (let j = 1; j < entries.length; j++) {
								const [k, v] = entries[j] ?? [];
								lines.push(`${propIndent}${k}: ${formatYamlValue(v)}`);
							}
						}
					} else {
						lines.push(`${itemIndent}- ${formatYamlValue(item)}`);
					}
				}
			}
		} else {
			lines.push(`${indent}${key}: ${formatYamlValue(value)}`);
		}
	}
}

/**
 * Format a scalar value for YAML output.
 */
function formatYamlValue(value: unknown): string {
	if (typeof value === "string") {
		// Quote strings that could be misinterpreted
		if (
			value === "" ||
			value === "true" ||
			value === "false" ||
			value === "null" ||
			value.includes(":") ||
			value.includes("#") ||
			value.includes("'") ||
			value.includes('"') ||
			value.includes("\n") ||
			/^\d/.test(value)
		) {
			// Use double quotes, escaping inner double quotes
			return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
		}
		return value;
	}

	if (typeof value === "number") {
		return String(value);
	}

	if (typeof value === "boolean") {
		return value ? "true" : "false";
	}

	if (value === null || value === undefined) {
		return "null";
	}

	return String(value);
}

/**
 * Deep merge source into target. Source values override target values.
 * Arrays from source replace (not append) target arrays.
 */
export function deepMerge(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...target };

	for (const key of Object.keys(source)) {
		const sourceVal = source[key];
		const targetVal = result[key];

		if (
			sourceVal !== null &&
			sourceVal !== undefined &&
			typeof sourceVal === "object" &&
			!Array.isArray(sourceVal) &&
			targetVal !== null &&
			targetVal !== undefined &&
			typeof targetVal === "object" &&
			!Array.isArray(targetVal)
		) {
			result[key] = deepMerge(
				targetVal as Record<string, unknown>,
				sourceVal as Record<string, unknown>,
			);
		} else if (sourceVal !== undefined) {
			result[key] = sourceVal;
		}
	}

	return result;
}
