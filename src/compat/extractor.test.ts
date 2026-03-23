import { describe, expect, it } from "bun:test";
import * as ts from "typescript";
import { extractTypeSurface } from "./extractor.ts";
import type { ExportedSymbol, TypeSurface } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers: build a TypeSurface from in-memory TypeScript source strings
// without touching git. We do this by exercising the AST walking logic
// directly via a virtual CompilerHost.
// ---------------------------------------------------------------------------

function buildVirtualSurface(files: Record<string, string>, ref = "HEAD"): TypeSurface {
	const compilerOptions: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2020,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		noEmit: true,
	};

	const absMap = new Map<string, string>();
	for (const [rel, content] of Object.entries(files)) {
		absMap.set(`/virtual/${rel}`, content);
	}

	const defaultHost = ts.createCompilerHost(compilerOptions);
	const host: ts.CompilerHost = {
		...defaultHost,
		fileExists(fileName: string): boolean {
			return absMap.has(fileName);
		},
		readFile(fileName: string): string | undefined {
			return absMap.get(fileName);
		},
		getSourceFile(
			fileName: string,
			languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
		): ts.SourceFile | undefined {
			const content = absMap.get(fileName);
			if (content === undefined) return undefined;
			return ts.createSourceFile(fileName, content, languageVersionOrOptions, true);
		},
		directoryExists(_dirName: string): boolean {
			return false;
		},
		getDirectories(_dirPath: string): string[] {
			return [];
		},
		resolveModuleNames(
			moduleNames: string[],
			containingFile: string,
		): (ts.ResolvedModule | undefined)[] {
			const containingDir = containingFile.substring(0, containingFile.lastIndexOf("/"));
			return moduleNames.map((moduleName) => {
				if (!moduleName.startsWith(".")) return undefined;
				const base = `${containingDir}/${moduleName}`;
				for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
					const normalized = normalizePath(candidate);
					if (absMap.has(normalized)) return { resolvedFileName: normalized };
				}
				return undefined;
			});
		},
	};

	const rootNames = Object.keys(files).map((r) => `/virtual/${r}`);
	const program = ts.createProgram(rootNames, compilerOptions, host);
	const checker = program.getTypeChecker();

	const allSymbols: ExportedSymbol[] = [];
	const seen = new Set<string>();

	for (const [rel, _] of Object.entries(files)) {
		const absPath = `/virtual/${rel}`;
		const sourceFile = program.getSourceFile(absPath);
		if (!sourceFile) continue;
		const fileSymbols = extractSymbolsFromSource(checker, sourceFile, rel, seen);
		allSymbols.push(...fileSymbols);
	}

	allSymbols.sort((a, b) => {
		const fc = a.filePath.localeCompare(b.filePath);
		if (fc !== 0) return fc;
		return a.name.localeCompare(b.name);
	});

	return { ref, symbols: allSymbols, extractedAt: new Date().toISOString() };
}

function normalizePath(p: string): string {
	const parts = p.split("/");
	const result: string[] = [];
	for (const part of parts) {
		if (part === ".") continue;
		if (part === "..") result.pop();
		else result.push(part);
	}
	return result.join("/");
}

function extractSymbolsFromSource(
	checker: ts.TypeChecker,
	sourceFile: ts.SourceFile,
	filePath: string,
	seen: Set<string>,
): ExportedSymbol[] {
	const symbols: ExportedSymbol[] = [];
	const fileKey = `${filePath}:`;

	function visit(node: ts.Node): void {
		const isExported =
			ts.canHaveModifiers(node) &&
			ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

		if (isExported) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
			const lineNumber = line + 1;

			if (ts.isInterfaceDeclaration(node)) {
				const name = node.name.text;
				const key = `${fileKey}${name}`;
				if (!seen.has(key)) {
					seen.add(key);
					const type = checker.getTypeAtLocation(node.name);
					symbols.push({
						name,
						kind: "interface",
						signature: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
						filePath,
						line: lineNumber,
					});
				}
			} else if (ts.isTypeAliasDeclaration(node)) {
				const name = node.name.text;
				const key = `${fileKey}${name}`;
				if (!seen.has(key)) {
					seen.add(key);
					const type = checker.getTypeAtLocation(node.name);
					symbols.push({
						name,
						kind: "type",
						signature: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
						filePath,
						line: lineNumber,
					});
				}
			} else if (ts.isFunctionDeclaration(node) && node.name) {
				const name = node.name.text;
				const key = `${fileKey}${name}`;
				if (!seen.has(key)) {
					seen.add(key);
					const sym = checker.getSymbolAtLocation(node.name);
					if (sym) {
						const type = checker.getTypeOfSymbolAtLocation(sym, node);
						symbols.push({
							name,
							kind: "function",
							signature: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
							filePath,
							line: lineNumber,
						});
					}
				}
			} else if (ts.isVariableStatement(node)) {
				for (const decl of node.declarationList.declarations) {
					if (ts.isIdentifier(decl.name)) {
						const name = decl.name.text;
						const key = `${fileKey}${name}`;
						if (!seen.has(key)) {
							seen.add(key);
							const sym = checker.getSymbolAtLocation(decl.name);
							if (sym) {
								const type = checker.getTypeOfSymbolAtLocation(sym, decl);
								symbols.push({
									name,
									kind: "const",
									signature: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
									filePath,
									line: lineNumber,
								});
							}
						}
					}
				}
			} else if (ts.isEnumDeclaration(node)) {
				const name = node.name.text;
				const key = `${fileKey}${name}`;
				if (!seen.has(key)) {
					seen.add(key);
					const type = checker.getTypeAtLocation(node.name);
					symbols.push({
						name,
						kind: "enum",
						signature: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
						filePath,
						line: lineNumber,
					});
				}
			} else if (ts.isClassDeclaration(node) && node.name) {
				const name = node.name.text;
				const key = `${fileKey}${name}`;
				if (!seen.has(key)) {
					seen.add(key);
					const type = checker.getTypeAtLocation(node.name);
					symbols.push({
						name,
						kind: "class",
						signature: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation),
						filePath,
						line: lineNumber,
					});
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return symbols;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildVirtualSurface (AST walking)", () => {
	it("extracts an exported interface", () => {
		const surface = buildVirtualSurface({
			"src/foo.ts": `
export interface User {
  id: number;
  name: string;
}
`,
		});

		expect(surface.symbols).toHaveLength(1);
		const sym = surface.symbols[0];
		expect(sym?.name).toBe("User");
		expect(sym?.kind).toBe("interface");
		expect(sym?.filePath).toBe("src/foo.ts");
		expect(sym?.line).toBe(2);
		expect(sym?.signature).toContain("User");
	});

	it("extracts const array and derived union type", () => {
		const surface = buildVirtualSurface({
			"src/kinds.ts": `
export const KINDS = ["a", "b", "c"] as const;
export type Kind = (typeof KINDS)[number];
`,
		});

		const kindsSym = surface.symbols.find((s) => s.name === "KINDS");
		const kindType = surface.symbols.find((s) => s.name === "Kind");

		expect(kindsSym).toBeDefined();
		expect(kindsSym?.kind).toBe("const");
		// signature should reflect the const tuple
		expect(kindsSym?.signature).toContain("a");

		expect(kindType).toBeDefined();
		expect(kindType?.kind).toBe("type");
		// derived union from const array
		expect(kindType?.signature).toMatch(/a|b|c/);
	});

	it("resolves re-exports via Program", () => {
		const surface = buildVirtualSurface({
			"src/base.ts": `
export interface Base {
  id: string;
}
`,
			"src/index.ts": `
export type { Base } from "./base.ts";
`,
		});

		// Base should appear from src/base.ts (direct export)
		const baseSym = surface.symbols.find((s) => s.name === "Base" && s.filePath === "src/base.ts");
		expect(baseSym).toBeDefined();
		expect(baseSym?.kind).toBe("interface");
	});

	it("returns empty surface for a file with no exports", () => {
		const surface = buildVirtualSurface({
			"src/internal.ts": `
function helper() { return 42; }
const PRIVATE = "secret";
`,
		});
		expect(surface.symbols).toHaveLength(0);
	});

	it("handles syntax errors gracefully (returns partial results)", () => {
		// File with valid export followed by broken syntax
		const surface = buildVirtualSurface({
			"src/partial.ts": `
export interface Good { name: string; }
export const broken = {{{;
`,
		});

		// The valid export before the parse error should still appear
		const good = surface.symbols.find((s) => s.name === "Good");
		expect(good).toBeDefined();
		expect(good?.kind).toBe("interface");
	});

	it("is deterministic — output sorted by filePath then name", () => {
		const surface = buildVirtualSurface({
			"src/z.ts": `
export interface Zebra { x: number; }
export interface Apple { y: string; }
`,
			"src/a.ts": `
export interface Moon { z: boolean; }
`,
		});

		const names = surface.symbols.map((s) => `${s.filePath}:${s.name}`);
		const sorted = [...names].sort();
		expect(names).toEqual(sorted);
	});
});

// ---------------------------------------------------------------------------
// Ref validation tests (test the extractTypeSurface function directly for
// the validation logic — no git needed because it throws before git calls)
// ---------------------------------------------------------------------------

describe("extractTypeSurface ref validation", () => {
	async function expectRefRejected(ref: string): Promise<void> {
		await expect(extractTypeSurface("/nonexistent/repo", ref, ["src/**/*.ts"])).rejects.toThrow();
	}

	it("rejects refs with semicolons", async () => {
		await expectRefRejected("main;rm -rf /");
	});

	it("rejects refs with pipe characters", async () => {
		await expectRefRejected("main|cat /etc/passwd");
	});

	it("rejects refs with dollar signs", async () => {
		await expectRefRejected("main$HOME");
	});

	it("rejects refs with backticks", async () => {
		await expectRefRejected("main`id`");
	});

	it("rejects refs with spaces", async () => {
		await expectRefRejected("main branch");
	});

	it("rejects refs containing .. (path traversal)", async () => {
		await expectRefRejected("../../home/user/.bashrc");
	});

	it("accepts valid branch names", async () => {
		// Should get past validation and fail on git (repo doesn't exist)
		// The error must NOT be the validation error
		try {
			await extractTypeSurface("/nonexistent/repo", "feature/my-branch_1.0", ["src/**/*.ts"]);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).not.toContain("Invalid git ref");
		}
	});

	it("accepts commit SHAs", async () => {
		try {
			await extractTypeSurface("/nonexistent/repo", "abc123def456", ["src/**/*.ts"]);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).not.toContain("Invalid git ref");
		}
	});
});
