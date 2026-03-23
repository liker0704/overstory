import * as ts from "typescript";
import type { ExportedSymbol, SymbolKind, TypeSurface } from "./types.ts";

// Regex: only alphanumeric, slash, underscore, dot, dash — no shell metacharacters
const REF_PATTERN = /^[a-zA-Z0-9/_.-]+$/;

function validateRef(ref: string): void {
	if (!REF_PATTERN.test(ref)) {
		throw new Error(`Invalid git ref: "${ref}" — contains disallowed characters`);
	}
	if (ref.includes("..")) {
		throw new Error(`Invalid git ref: "${ref}" — contains ".." sequence`);
	}
}

/** Match a file path against a list of glob patterns using minimatch-style logic. */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
	if (patterns.length === 0) return true;
	return patterns.some((pattern) => {
		// Simple glob: support ** prefix and suffix, *.ext
		const regexStr = pattern
			.replace(/\./g, "\\.")
			.replace(/\*\*/g, ".*")
			.replace(/\*/g, "[^/]*")
			.replace(/\?/g, "[^/]");
		return new RegExp(`^${regexStr}$`).test(filePath);
	});
}

/**
 * Read all matched files at a given git ref using git cat-file --batch.
 * Returns a map from repo-relative path to file content.
 */
async function batchReadFiles(
	repoRoot: string,
	ref: string,
	filePaths: string[],
): Promise<Map<string, string>> {
	if (filePaths.length === 0) return new Map();

	// Build the batch input: "<ref>:<path>\n" for each file
	const batchInput = `${filePaths.map((p) => `${ref}:${p}`).join("\n")}\n`;

	const proc = Bun.spawn(["git", "cat-file", "--batch"], {
		cwd: repoRoot,
		stdin: new TextEncoder().encode(batchInput),
		stdout: "pipe",
		stderr: "pipe",
	});

	const rawBuffer = await new Response(proc.stdout).arrayBuffer();
	const raw = new TextDecoder().decode(rawBuffer);
	await proc.exited;

	const result = new Map<string, string>();
	// git cat-file --batch output format per entry:
	//   "<hash> <type> <size>\n<content>\n"
	// Missing objects output: "<object-name> missing\n"
	let pos = 0;
	let fileIndex = 0;
	while (pos < raw.length && fileIndex < filePaths.length) {
		const headerEnd = raw.indexOf("\n", pos);
		if (headerEnd === -1) break;
		const header = raw.slice(pos, headerEnd);
		pos = headerEnd + 1;

		if (header.endsWith(" missing") || header.endsWith("missing")) {
			fileIndex++;
			continue;
		}

		const parts = header.split(" ");
		const size = parseInt(parts[2] ?? "0", 10);
		if (Number.isNaN(size)) {
			fileIndex++;
			continue;
		}

		const content = raw.slice(pos, pos + size);
		const filePath = filePaths[fileIndex];
		if (filePath !== undefined) {
			result.set(filePath, content);
		}
		pos += size + 1; // +1 for trailing newline after content
		fileIndex++;
	}

	return result;
}

/**
 * Use git ls-tree to get the list of files at a ref matching the given patterns.
 */
async function listFiles(repoRoot: string, ref: string, filePatterns: string[]): Promise<string[]> {
	const proc = Bun.spawn(["git", "ls-tree", "--name-only", "-r", ref], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});

	const text = await new Response(proc.stdout).text();
	await proc.exited;

	const allFiles = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);

	return allFiles.filter((f) => matchesAnyPattern(f, filePatterns));
}

/** Create a virtual CompilerHost backed by an in-memory file map. */
function createVirtualHost(
	fileMap: Map<string, string>,
	repoRoot: string,
	compilerOptions: ts.CompilerOptions,
): ts.CompilerHost {
	const defaultHost = ts.createCompilerHost(compilerOptions);

	// Normalize: map keys are repo-relative; we'll use /<repoRoot>/<path> as virtual absolute paths
	const absMap = new Map<string, string>();
	for (const [rel, content] of fileMap) {
		absMap.set(`${repoRoot}/${rel}`, content);
	}

	return {
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
		// Explicitly disable filesystem fallback
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
				// Resolve relative imports only — no node_modules
				if (!moduleName.startsWith(".")) return undefined;
				const candidates = [
					`${containingDir}/${moduleName}`,
					`${containingDir}/${moduleName}.ts`,
					`${containingDir}/${moduleName}.tsx`,
					`${containingDir}/${moduleName}/index.ts`,
				];
				for (const c of candidates) {
					// Normalize path (handle ../)
					const normalized = normalizePath(c);
					if (absMap.has(normalized)) {
						return { resolvedFileName: normalized };
					}
				}
				return undefined;
			});
		},
	};
}

/** Simple path normalizer: handle `./` and `../` */
function normalizePath(p: string): string {
	const parts = p.split("/");
	const result: string[] = [];
	for (const part of parts) {
		if (part === ".") continue;
		if (part === "..") {
			result.pop();
		} else {
			result.push(part);
		}
	}
	return result.join("/");
}

/** Serialize a TypeScript type to a string for comparison. */
function serializeType(checker: ts.TypeChecker, type: ts.Type): string {
	return checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
}

/** Walk a source file and extract all exported symbols. */
function extractFromSourceFile(
	checker: ts.TypeChecker,
	sourceFile: ts.SourceFile,
	filePath: string,
	depth: number,
	maxDepth: number,
	seen: Set<string>,
): ExportedSymbol[] {
	const symbols: ExportedSymbol[] = [];
	const fileKey = `${filePath}:`;

	function visit(node: ts.Node): void {
		// Check for export keyword
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
						kind: "interface" as SymbolKind,
						signature: serializeType(checker, type),
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
						kind: "type" as SymbolKind,
						signature: serializeType(checker, type),
						filePath,
						line: lineNumber,
					});
				}
			} else if (ts.isFunctionDeclaration(node) && node.name) {
				const name = node.name.text;
				const key = `${fileKey}${name}`;
				if (!seen.has(key)) {
					seen.add(key);
					const symbol = checker.getSymbolAtLocation(node.name);
					if (symbol) {
						const type = checker.getTypeOfSymbolAtLocation(symbol, node);
						symbols.push({
							name,
							kind: "function" as SymbolKind,
							signature: serializeType(checker, type),
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
							const symbol = checker.getSymbolAtLocation(decl.name);
							if (symbol) {
								const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
								symbols.push({
									name,
									kind: "const" as SymbolKind,
									signature: serializeType(checker, type),
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
						kind: "enum" as SymbolKind,
						signature: serializeType(checker, type),
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
						kind: "class" as SymbolKind,
						signature: serializeType(checker, type),
						filePath,
						line: lineNumber,
					});
				}
			}
		}

		// Handle re-exports: export { X } from "./other" or export * from "./other"
		// Re-exports are handled at depth limit to prevent combinatorial explosion.
		// The Program's type checker resolves them when the source file is present in rootNames.
		if (ts.isExportDeclaration(node) && node.moduleSpecifier && depth < maxDepth) {
			const moduleSpec = (node.moduleSpecifier as ts.StringLiteral).text;
			if (moduleSpec.startsWith(".")) {
				// Symbols from re-exported modules appear in their own source files
				// which are already walked by the outer loop via the Program.
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return symbols;
}

/**
 * Extract the TypeScript type surface from a git ref.
 *
 * @param repoRoot - Absolute path to the git repo root
 * @param ref - Git ref (branch name, commit SHA, tag)
 * @param filePatterns - Glob patterns to filter files (e.g., ["src/**\/*.ts"])
 */
export async function extractTypeSurface(
	repoRoot: string,
	ref: string,
	filePatterns: string[],
): Promise<TypeSurface> {
	validateRef(ref);

	// 1. Get list of matching files at ref
	const filePaths = await listFiles(repoRoot, ref, filePatterns);

	// 2. Batch-read all file contents
	const fileMap = await batchReadFiles(repoRoot, ref, filePaths);

	// 3. Create TypeScript program with virtual host
	const compilerOptions: ts.CompilerOptions = {
		target: ts.ScriptTarget.ES2020,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		strict: true,
		noEmit: true,
	};

	// Map repo-relative paths to absolute virtual paths
	const rootNames = filePaths.filter((p) => fileMap.has(p)).map((p) => `${repoRoot}/${p}`);

	const host = createVirtualHost(fileMap, repoRoot, compilerOptions);
	const program = ts.createProgram(rootNames, compilerOptions, host);
	const checker = program.getTypeChecker();

	// 4. Walk each source file and collect symbols
	const allSymbols: ExportedSymbol[] = [];
	const seen = new Set<string>();

	for (const filePath of filePaths) {
		const absPath = `${repoRoot}/${filePath}`;
		const sourceFile = program.getSourceFile(absPath);
		if (!sourceFile) continue;

		const fileSymbols = extractFromSourceFile(checker, sourceFile, filePath, 0, 2, seen);
		allSymbols.push(...fileSymbols);
	}

	// 5. Sort by file path then name for determinism
	allSymbols.sort((a, b) => {
		const fileCompare = a.filePath.localeCompare(b.filePath);
		if (fileCompare !== 0) return fileCompare;
		return a.name.localeCompare(b.name);
	});

	return {
		ref,
		symbols: allSymbols,
		extractedAt: new Date().toISOString(),
	};
}
