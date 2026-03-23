import type { NamingVocabulary, SignalAnalyzer } from "../types.ts";

const MAX_FILES = 500;

const KNOWN_PREFIXES = [
	"create",
	"get",
	"set",
	"is",
	"has",
	"handle",
	"use",
	"on",
	"load",
	"build",
	"parse",
	"format",
	"check",
	"update",
	"delete",
	"remove",
	"add",
	"fetch",
	"run",
	"start",
	"stop",
];

// Regex to match exported function/class/const declarations
const DECL_PATTERNS = [
	// TypeScript/JavaScript: export function name, export const name, export class name
	/export\s+(?:async\s+)?(?:function|class|const|let)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
	// Python: def name, class name
	/^(?:def|class)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm,
	// Rust: pub fn name, pub struct name
	/pub\s+(?:async\s+)?(?:fn|struct|enum)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
	// Go: func Name
	/^func\s+([A-Za-z][a-zA-Z0-9_]*)/gm,
];

function extractNames(content: string): string[] {
	const names: string[] = [];
	for (const pattern of DECL_PATTERNS) {
		const re = new RegExp(pattern.source, pattern.flags);
		let m: RegExpExecArray | null;
		m = re.exec(content);
		while (m !== null) {
			const name = m[1];
			if (name) names.push(name);
			m = re.exec(content);
		}
	}
	return names;
}

function detectPrefix(name: string): string | null {
	for (const prefix of KNOWN_PREFIXES) {
		if (name.startsWith(prefix) && name.length > prefix.length) {
			const nextChar = name[prefix.length];
			if (nextChar && nextChar === nextChar.toUpperCase()) return prefix;
		}
	}
	return null;
}

function isCamelCase(name: string): boolean {
	return /^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name);
}

function isSnakeCase(name: string): boolean {
	return /^[a-z][a-z0-9_]*_[a-z0-9_]*$/.test(name);
}

function isPascalCase(name: string): boolean {
	return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

export const analyzeNamingVocabulary: SignalAnalyzer<NamingVocabulary> = async (
	projectRoot: string,
): Promise<NamingVocabulary> => {
	const prefixCounts = new Map<string, number>();
	let camelCount = 0;
	let snakeCount = 0;
	let pascalCount = 0;

	try {
		const glob = new Bun.Glob("**/*.{ts,js,py,rs,go}");
		const files: string[] = [];

		for await (const file of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
			if (
				file.includes("node_modules") ||
				file.includes(".git") ||
				file.includes("dist/") ||
				file.includes("build/")
			)
				continue;
			files.push(file);
			if (files.length >= MAX_FILES) break;
		}

		for (const file of files) {
			let content: string;
			try {
				content = await Bun.file(`${projectRoot}/${file}`).text();
			} catch {
				continue;
			}

			const names = extractNames(content);
			for (const name of names) {
				const prefix = detectPrefix(name);
				if (prefix) {
					prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
				}
				if (isCamelCase(name)) camelCount++;
				else if (isSnakeCase(name)) snakeCount++;
				else if (isPascalCase(name)) pascalCount++;
			}
		}
	} catch {
		// return empty on failure
	}

	// Top 10 prefixes by frequency
	const sortedPrefixes = [...prefixCounts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([prefix]) => prefix);

	// Determine dominant convention
	const conventions: { pattern: string; description: string }[] = [];
	const total = camelCount + snakeCount + pascalCount;
	if (total > 0) {
		if (camelCount >= snakeCount && camelCount >= pascalCount) {
			conventions.push({
				pattern: "camelCase",
				description: "Function and variable names use camelCase",
			});
		} else if (snakeCount >= camelCount && snakeCount >= pascalCount) {
			conventions.push({
				pattern: "snake_case",
				description: "Function and variable names use snake_case",
			});
		}
		if (pascalCount > 0) {
			conventions.push({
				pattern: "PascalCase",
				description: "Class and type names use PascalCase",
			});
		}
	}

	return { commonPrefixes: sortedPrefixes, conventions };
};

export default analyzeNamingVocabulary;
