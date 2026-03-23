import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectContext } from "../context/types.ts";
import { executeContextGenerate, executeContextInvalidate, executeContextShow } from "./context.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeTempProject(): Promise<{
	root: string;
	ovDir: string;
	cleanup: () => Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), "ov-context-test-"));
	const ovDir = join(root, ".overstory");
	await Bun.write(join(root, "package.json"), '{"name":"test","version":"0.0.1"}');
	// Create .overstory dir by writing a placeholder
	await Bun.write(join(ovDir, ".keep"), "");
	return {
		root,
		ovDir,
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

// ─── generate ─────────────────────────────────────────────────────────────────

describe("executeContextGenerate", () => {
	let tmpRoot: string;
	let ovDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const proj = await makeTempProject();
		tmpRoot = proj.root;
		ovDir = proj.ovDir;
		cleanup = proj.cleanup;
	});

	afterEach(async () => {
		await cleanup();
	});

	it("generates context cache file", async () => {
		const cachePath = join(ovDir, "project-context.json");
		expect(existsSync(cachePath)).toBe(false);

		// Stub loadConfig via dynamic import mocking is tricky, so we test through
		// the actual execution by pointing cwd at a temp project and using real config
		// We can't easily mock loadConfig here without module mocks, so test indirectly
		// by verifying analyzeProject + writeCachedContext behavior in integration style.

		// Instead, test that the cache file is written by mocking config inline:
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		await executeContextGenerate({});

		expect(existsSync(cachePath)).toBe(true);
		const raw = JSON.parse(await Bun.file(cachePath).text()) as ProjectContext;
		expect(raw.version).toBe(1);
		expect(typeof raw.generatedAt).toBe("string");
		expect(typeof raw.structuralHash).toBe("string");

		loadConfigSpy.mockRestore();
	});

	it("skips regeneration when cache is valid and --force not passed", async () => {
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		// Pre-seed a cache file with a known structural hash.
		// We must write the cache file first so it's part of the directory listing
		// when computing the hash (level-2 scan includes .overstory contents).
		const cachePath = join(ovDir, "project-context.json");
		await Bun.write(cachePath, "placeholder");
		const { computeStructuralHash } = await import("../context/cache.ts");
		const hash = await computeStructuralHash(tmpRoot);
		const seedCtx: ProjectContext = {
			version: 1,
			generatedAt: "2025-01-01T00:00:00.000Z",
			structuralHash: hash,
			signals: {
				languages: [],
				directoryProfile: { sourceRoots: [], testRoots: [], zones: [] },
				namingVocabulary: { commonPrefixes: [], conventions: [] },
				testConventions: { framework: "", filePattern: "", testRoots: [], setupFiles: [] },
				errorPatterns: { throwStyle: "unknown", patterns: [] },
				importHotspots: [],
				configZones: [],
				sharedInvariants: [],
			},
		};
		await Bun.write(cachePath, `${JSON.stringify(seedCtx, null, 2)}\n`);

		const written: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});

		// Generate without --force — should print "up to date" not regenerate
		await executeContextGenerate({});

		const output = written.join("");
		expect(output).toContain("up to date");

		// Cache file should still have original generatedAt
		const after = JSON.parse(await Bun.file(cachePath).text()) as ProjectContext;
		expect(after.generatedAt).toBe("2025-01-01T00:00:00.000Z");

		stdoutSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("regenerates when --force is passed", async () => {
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		await executeContextGenerate({});
		const cachePath = join(ovDir, "project-context.json");
		const firstStat = (await Bun.file(cachePath).stat()).mtime;

		// Small wait to ensure mtime differs
		await new Promise((resolve) => setTimeout(resolve, 10));

		await executeContextGenerate({ force: true });
		const secondStat = (await Bun.file(cachePath).stat()).mtime;

		// File was rewritten
		expect(existsSync(cachePath)).toBe(true);
		expect(secondStat).not.toEqual(firstStat);

		loadConfigSpy.mockRestore();
	});

	it("outputs JSON when --json flag is set", async () => {
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		const written: string[] = [];
		const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});

		await executeContextGenerate({ json: true });

		const output = written.join("");
		const parsed = JSON.parse(output) as { success: boolean; status: string };
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe("generated");

		writeSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});
});

// ─── show ──────────────────────────────────────────────────────────────────────

describe("executeContextShow", () => {
	let tmpRoot: string;
	let ovDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const proj = await makeTempProject();
		tmpRoot = proj.root;
		ovDir = proj.ovDir;
		cleanup = proj.cleanup;
	});

	afterEach(async () => {
		await cleanup();
	});

	it("writes error when no cache exists", async () => {
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		const stderrLines: string[] = [];
		const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => {
			stderrLines.push(String(chunk));
			return true;
		});

		await executeContextShow({});

		expect(stderrLines.join("")).toContain("No cached context");
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;

		stderrSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("renders context when cache exists", async () => {
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		// Seed a minimal context file
		const ctx: ProjectContext = {
			version: 1,
			generatedAt: new Date().toISOString(),
			structuralHash: "abc123",
			signals: {
				languages: [{ language: "TypeScript", configFile: "tsconfig.json" }],
				directoryProfile: { sourceRoots: ["src"], testRoots: [], zones: [] },
				namingVocabulary: { commonPrefixes: [], conventions: [] },
				testConventions: {
					framework: "bun",
					filePattern: "*.test.ts",
					testRoots: [],
					setupFiles: [],
				},
				errorPatterns: { throwStyle: "throw", patterns: [] },
				importHotspots: [],
				configZones: [],
				sharedInvariants: [],
			},
		};
		await Bun.write(join(ovDir, "project-context.json"), `${JSON.stringify(ctx, null, 2)}\n`);

		const stdoutLines: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdoutLines.push(String(chunk));
			return true;
		});

		await executeContextShow({});

		const output = stdoutLines.join("");
		expect(output).toContain("Project Context");

		stdoutSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("outputs raw JSON with --json flag", async () => {
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		const ctx: ProjectContext = {
			version: 1,
			generatedAt: new Date().toISOString(),
			structuralHash: "deadbeef",
			signals: {
				languages: [],
				directoryProfile: { sourceRoots: [], testRoots: [], zones: [] },
				namingVocabulary: { commonPrefixes: [], conventions: [] },
				testConventions: { framework: "", filePattern: "", testRoots: [], setupFiles: [] },
				errorPatterns: { throwStyle: "unknown", patterns: [] },
				importHotspots: [],
				configZones: [],
				sharedInvariants: [],
			},
		};
		await Bun.write(join(ovDir, "project-context.json"), `${JSON.stringify(ctx, null, 2)}\n`);

		const written: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});

		await executeContextShow({ json: true });

		const output = written.join("");
		const parsed = JSON.parse(output) as { success: boolean; version: number };
		expect(parsed.success).toBe(true);
		expect(parsed.version).toBe(1);

		stdoutSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});
});

// ─── invalidate ───────────────────────────────────────────────────────────────

describe("executeContextInvalidate", () => {
	let tmpRoot: string;
	let ovDir: string;
	let cleanup: () => Promise<void>;

	beforeEach(async () => {
		const proj = await makeTempProject();
		tmpRoot = proj.root;
		ovDir = proj.ovDir;
		cleanup = proj.cleanup;
	});

	afterEach(async () => {
		await cleanup();
	});

	it("deletes cache file when it exists", async () => {
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		const cachePath = join(ovDir, "project-context.json");
		await Bun.write(cachePath, '{"version":1}\n');
		expect(existsSync(cachePath)).toBe(true);

		await executeContextInvalidate({});

		expect(existsSync(cachePath)).toBe(false);

		loadConfigSpy.mockRestore();
	});

	it("reports not found when cache does not exist", async () => {
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		const written: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});

		await executeContextInvalidate({});

		expect(written.join("")).toContain("No context cache");

		stdoutSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});

	it("outputs JSON confirmation with --json flag", async () => {
		const config = await import("../config.ts");
		const loadConfigSpy = spyOn(config, "loadConfig").mockResolvedValue({
			project: { root: tmpRoot, name: "test" },
		} as Awaited<ReturnType<typeof config.loadConfig>>);

		const cachePath = join(ovDir, "project-context.json");
		await Bun.write(cachePath, '{"version":1}\n');

		const written: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});

		await executeContextInvalidate({ json: true });

		const output = written.join("");
		const parsed = JSON.parse(output) as { success: boolean; status: string };
		expect(parsed.success).toBe(true);
		expect(parsed.status).toBe("deleted");

		stdoutSpy.mockRestore();
		loadConfigSpy.mockRestore();
	});
});
