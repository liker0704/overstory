import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeStructuralHash,
	isCacheValid,
	readCachedContext,
	writeCachedContext,
} from "./cache.ts";
import type { ProjectContext } from "./types.ts";

function makeContext(hash = "abc123def456"): ProjectContext {
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
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
}

async function mkTempDir(): Promise<string> {
	const dir = join(tmpdir(), `ov-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

describe("computeStructuralHash", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkTempDir();
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("returns 64-char hex string", async () => {
		const hash = await computeStructuralHash(tmpDir);
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("hash changes when directory structure changes", async () => {
		const hash1 = await computeStructuralHash(tmpDir);
		await writeFile(join(tmpDir, "newfile.txt"), "content");
		const hash2 = await computeStructuralHash(tmpDir);
		expect(hash1).not.toBe(hash2);
	});

	test("hash stays stable for same inputs", async () => {
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
		const hash1 = await computeStructuralHash(tmpDir);
		const hash2 = await computeStructuralHash(tmpDir);
		expect(hash1).toBe(hash2);
	});

	test("extraInputs are included in hash", async () => {
		const extraFile = join(tmpDir, "extra.txt");
		await writeFile(extraFile, "v1");
		const hash1 = await computeStructuralHash(tmpDir, [extraFile]);
		await writeFile(extraFile, "v2");
		const hash2 = await computeStructuralHash(tmpDir, [extraFile]);
		expect(hash1).not.toBe(hash2);
	});
});

describe("readCachedContext", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkTempDir();
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("returns null for missing file", () => {
		const result = readCachedContext(join(tmpDir, "nonexistent.json"));
		expect(result).toBeNull();
	});

	test("returns null for corrupt JSON", async () => {
		const path = join(tmpDir, "corrupt.json");
		await writeFile(path, "not valid json {{{{");
		expect(readCachedContext(path)).toBeNull();
	});

	test("returns null for wrong version", async () => {
		const path = join(tmpDir, "wrong-version.json");
		await writeFile(
			path,
			JSON.stringify({ version: 2, generatedAt: "", structuralHash: "", signals: {} }),
		);
		expect(readCachedContext(path)).toBeNull();
	});

	test("roundtrips with writeCachedContext", async () => {
		const path = join(tmpDir, "context.json");
		const ctx = makeContext("roundtriphash");
		await writeCachedContext(path, ctx);
		const result = readCachedContext(path);
		expect(result).not.toBeNull();
		expect(result?.structuralHash).toBe("roundtriphash");
		expect(result?.version).toBe(1);
	});

	test("written file has trailing newline", async () => {
		const path = join(tmpDir, "context.json");
		await writeCachedContext(path, makeContext());
		const raw = await Bun.file(path).text();
		expect(raw.endsWith("\n")).toBe(true);
	});
});

describe("isCacheValid", () => {
	test("returns true for matching hash and version 1", () => {
		const ctx = makeContext("testhash");
		expect(isCacheValid(ctx, "testhash")).toBe(true);
	});

	test("returns false for mismatched hash", () => {
		const ctx = makeContext("testhash");
		expect(isCacheValid(ctx, "differenthash")).toBe(false);
	});

	test("returns false for empty hash", () => {
		const ctx = makeContext("testhash");
		expect(isCacheValid(ctx, "")).toBe(false);
	});
});
