import { readdir } from "node:fs/promises";
import type { SharedInvariant, SignalAnalyzer } from "../types.ts";

async function fileExists(path: string): Promise<boolean> {
	try {
		return await Bun.file(path).exists();
	} catch {
		return false;
	}
}

async function dirExists(path: string): Promise<boolean> {
	try {
		await readdir(path);
		return true;
	} catch {
		return false;
	}
}

async function readText(path: string): Promise<string | null> {
	try {
		return await Bun.file(path).text();
	} catch {
		return null;
	}
}

export const analyzeSharedInvariants: SignalAnalyzer<SharedInvariant[]> = async (projectRoot) => {
	const results: SharedInvariant[] = [];

	// Linter: biome.json
	if (await fileExists(`${projectRoot}/biome.json`)) {
		const content = await readText(`${projectRoot}/biome.json`);
		let desc = "Biome linter/formatter configured";
		if (content !== null) {
			try {
				const parsed = JSON.parse(content) as Record<string, unknown>;
				const parts: string[] = [];
				if (parsed.formatter) parts.push("formatter");
				if (parsed.linter) parts.push("linter");
				if (parsed.organizeImports) parts.push("import organizer");
				if (parts.length > 0) desc = `Biome: ${parts.join(", ")}`;
			} catch {
				// keep default desc
			}
		}
		results.push({ type: "linter", description: desc, source: "biome.json" });
	}

	// Linter: .eslintrc*
	const eslintFiles = [
		".eslintrc",
		".eslintrc.js",
		".eslintrc.json",
		".eslintrc.yml",
		".eslintrc.yaml",
	];
	for (const f of eslintFiles) {
		if (await fileExists(`${projectRoot}/${f}`)) {
			results.push({ type: "linter", description: "ESLint linting rules configured", source: f });
			break;
		}
	}

	// Formatter: .prettierrc*
	const prettierFiles = [".prettierrc", ".prettierrc.js", ".prettierrc.json", ".prettierrc.yml"];
	for (const f of prettierFiles) {
		if (await fileExists(`${projectRoot}/${f}`)) {
			results.push({
				type: "formatting",
				description: "Prettier formatting configured",
				source: f,
			});
			break;
		}
	}

	// TypeScript strict mode
	if (await fileExists(`${projectRoot}/tsconfig.json`)) {
		const content = await readText(`${projectRoot}/tsconfig.json`);
		if (content !== null) {
			try {
				const parsed = JSON.parse(content) as Record<string, unknown>;
				const co = parsed.compilerOptions as Record<string, unknown> | undefined;
				if (co) {
					const strictFlags = [
						"strict",
						"noUncheckedIndexedAccess",
						"noImplicitAny",
						"strictNullChecks",
						"strictFunctionTypes",
					];
					const enabled = strictFlags.filter((f) => co[f] === true);
					if (enabled.length > 0) {
						results.push({
							type: "typecheck",
							description: `TypeScript strict mode: ${enabled.join(", ")}`,
							source: "tsconfig.json",
						});
					}
				}
			} catch {
				// ignore parse errors
			}
		}
	}

	// Git hooks: .husky/
	if (await dirExists(`${projectRoot}/.husky`)) {
		results.push({ type: "hooks", description: "Husky git hooks configured", source: ".husky/" });
	}

	// Git hooks: .git/hooks/
	if (await dirExists(`${projectRoot}/.git/hooks`)) {
		results.push({
			type: "hooks",
			description: "Git hooks directory present",
			source: ".git/hooks/",
		});
	}

	// Lefthook
	if (await fileExists(`${projectRoot}/lefthook.yml`)) {
		results.push({
			type: "hooks",
			description: "Lefthook git hooks configured",
			source: "lefthook.yml",
		});
	}

	// lint-staged (check package.json)
	if (await fileExists(`${projectRoot}/package.json`)) {
		const content = await readText(`${projectRoot}/package.json`);
		if (content !== null) {
			try {
				const parsed = JSON.parse(content) as Record<string, unknown>;
				if (parsed["lint-staged"]) {
					results.push({
						type: "hooks",
						description: "lint-staged pre-commit checks configured",
						source: "package.json",
					});
				}
			} catch {
				// ignore
			}
		}
	}

	// Pre-commit
	if (await fileExists(`${projectRoot}/.pre-commit-config.yaml`)) {
		results.push({
			type: "hooks",
			description: "pre-commit framework hooks configured",
			source: ".pre-commit-config.yaml",
		});
	}

	// EditorConfig
	if (await fileExists(`${projectRoot}/.editorconfig`)) {
		const content = await readText(`${projectRoot}/.editorconfig`);
		let desc = "EditorConfig enforces editor consistency";
		if (content !== null) {
			if (content.includes("indent_style")) {
				const style = content.includes("indent_style = tab") ? "tab" : "space";
				desc = `EditorConfig: indent_style=${style}`;
			}
		}
		results.push({ type: "editor", description: desc, source: ".editorconfig" });
	}

	return results;
};
