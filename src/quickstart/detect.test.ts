import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { areHooksInstalled, isInitialized, isRuntimeAvailable } from "./detect.ts";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "ov-detect-test-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isInitialized
// ---------------------------------------------------------------------------

describe("isInitialized", () => {
	test("returns false when .overstory/config.yaml does not exist", async () => {
		const result = await isInitialized(tmpDir);
		expect(result).toBe(false);
	});

	test("returns true when .overstory/config.yaml exists", async () => {
		await mkdir(join(tmpDir, ".overstory"), { recursive: true });
		await writeFile(join(tmpDir, ".overstory", "config.yaml"), "version: 2\n");
		const result = await isInitialized(tmpDir);
		expect(result).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// areHooksInstalled
// ---------------------------------------------------------------------------

describe("areHooksInstalled", () => {
	test("returns false when .overstory/hooks.json does not exist", async () => {
		const result = await areHooksInstalled(tmpDir);
		expect(result).toBe(false);
	});

	test("returns false when hooks.json exists but settings.local.json is missing", async () => {
		await mkdir(join(tmpDir, ".overstory"), { recursive: true });
		await writeFile(join(tmpDir, ".overstory", "hooks.json"), "{}");
		const result = await areHooksInstalled(tmpDir);
		expect(result).toBe(false);
	});

	test("returns false when settings.local.json exists but has no overstory reference", async () => {
		await mkdir(join(tmpDir, ".overstory"), { recursive: true });
		await writeFile(join(tmpDir, ".overstory", "hooks.json"), "{}");
		await mkdir(join(tmpDir, ".claude"), { recursive: true });
		await writeFile(join(tmpDir, ".claude", "settings.local.json"), '{"permissions":[]}');
		const result = await areHooksInstalled(tmpDir);
		expect(result).toBe(false);
	});

	test("returns true when both files exist and settings references overstory", async () => {
		await mkdir(join(tmpDir, ".overstory"), { recursive: true });
		await writeFile(join(tmpDir, ".overstory", "hooks.json"), "{}");
		await mkdir(join(tmpDir, ".claude"), { recursive: true });
		await writeFile(
			join(tmpDir, ".claude", "settings.local.json"),
			'{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"overstory prime"}]}]}}',
		);
		const result = await areHooksInstalled(tmpDir);
		expect(result).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// isRuntimeAvailable
// ---------------------------------------------------------------------------

describe("isRuntimeAvailable", () => {
	const originalKey = process.env.ANTHROPIC_API_KEY;

	afterEach(() => {
		if (originalKey === undefined) {
			delete process.env.ANTHROPIC_API_KEY;
		} else {
			process.env.ANTHROPIC_API_KEY = originalKey;
		}
	});

	test("returns true when ANTHROPIC_API_KEY is set", async () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
		const result = await isRuntimeAvailable();
		expect(result).toBe(true);
	});

	test("returns false when ANTHROPIC_API_KEY is empty string", async () => {
		process.env.ANTHROPIC_API_KEY = "";
		const result = await isRuntimeAvailable();
		expect(result).toBe(false);
	});

	test("returns false when ANTHROPIC_API_KEY is not set", async () => {
		delete process.env.ANTHROPIC_API_KEY;
		const result = await isRuntimeAvailable();
		expect(result).toBe(false);
	});
});
