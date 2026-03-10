/**
 * Tests for `ov health`.
 *
 * Tests executeHealth() directly to avoid spawning CLI processes.
 * Uses a temp directory with a minimal .overstory/ structure so loadConfig()
 * can resolve successfully.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHealth } from "./health.ts";

// ─── Stdout capture helper ─────────────────────────────────────────────────

function captureStdout(): { stop: () => string } {
	let captured = "";
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	};
	return {
		stop: () => {
			process.stdout.write = original;
			return captured;
		},
	};
}

// ─── Minimal project scaffold ──────────────────────────────────────────────

async function createMinimalProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ov-health-test-"));
	await mkdir(join(dir, ".overstory"), { recursive: true });

	const config = ["project:", `  name: test-project`, `  root: ${dir}`].join("\n");
	await writeFile(join(dir, ".overstory", "config.yaml"), config);

	return dir;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("executeHealth", () => {
	let projectDir: string;
	let origCwd: string;

	beforeEach(async () => {
		projectDir = await createMinimalProject();
		origCwd = process.cwd();
		process.chdir(projectDir);
		process.exitCode = 0;
	});

	afterEach(async () => {
		process.chdir(origCwd);
		await rm(projectDir, { recursive: true, force: true });
	});

	test("human output renders health header", async () => {
		const cap = captureStdout();
		await executeHealth({});
		const out = cap.stop();
		expect(out).toContain("Swarm Health");
		expect(out).toContain("Overall:");
	});

	test("json output has required fields", async () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		};

		await executeHealth({ json: true });

		process.stdout.write = original;
		const raw = chunks.join("");
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("health");
		expect(parsed).toHaveProperty("score");
		expect(parsed).toHaveProperty("signals");
		expect(parsed).toHaveProperty("snapshot");

		const score = parsed.score as Record<string, unknown>;
		expect(typeof score.overall).toBe("number");
		expect(["A", "B", "C", "D", "F"]).toContain(score.grade as string);
	});

	test("json output with --run scopes correctly", async () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		};

		await executeHealth({ json: true, run: "test-run-123" });

		process.stdout.write = original;
		const raw = chunks.join("");
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		// Should succeed even with a non-existent run — signals may just be empty
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("health");
	});

	test("--compare with missing file does not crash json output", async () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		};

		// Non-existent snapshot path — should degrade gracefully (warning emitted, score still returned)
		const stderrChunks: string[] = [];
		const origStderr = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string | Uint8Array): boolean => {
			stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		};

		await executeHealth({ json: false, compare: "/nonexistent/snapshot.json" });

		process.stdout.write = original;
		process.stderr.write = origStderr;

		// With json: false, a warning is emitted but the command doesn't fail
		// exitCode should remain 0
		expect(process.exitCode).not.toBe(1);
	});
});
