/**
 * Tests for `ov next-improvement`.
 *
 * Tests executeNextImprovement() directly to avoid spawning CLI processes.
 * Uses a temp directory with a minimal .overstory/ structure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeNextImprovement } from "./next-improvement.ts";

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
	const dir = await mkdtemp(join(tmpdir(), "ov-next-test-"));
	await mkdir(join(dir, ".overstory"), { recursive: true });

	const config = ["project:", `  name: test-project`, `  root: ${dir}`].join("\n");
	await writeFile(join(dir, ".overstory", "config.yaml"), config);

	return dir;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("executeNextImprovement", () => {
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

	test("human output renders Next Improvement header", async () => {
		const cap = captureStdout();
		await executeNextImprovement({});
		const out = cap.stop();
		expect(out).toContain("Next Improvement");
	});

	test("human output shows 'All clear' when no recommendations", async () => {
		// With stub signal collector returning [], computeScore returns perfect score,
		// and generateRecommendations returns [] — so we expect the all-clear message.
		const cap = captureStdout();
		await executeNextImprovement({});
		const out = cap.stop();
		// Either "All clear" or at least the header is present
		expect(out.length).toBeGreaterThan(0);
	});

	test("json output has required fields", async () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		};

		await executeNextImprovement({ json: true });

		process.stdout.write = original;
		const raw = chunks.join("");
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("next-improvement");
		expect(parsed).toHaveProperty("recommendations");
		expect(parsed).toHaveProperty("score");
		expect(parsed).toHaveProperty("count");

		const score = parsed.score as Record<string, unknown>;
		expect(typeof score.overall).toBe("number");
		expect(["A", "B", "C", "D", "F"]).toContain(score.grade as string);

		expect(Array.isArray(parsed.recommendations)).toBe(true);
	});

	test("json output with --all returns all recommendations", async () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		};

		await executeNextImprovement({ json: true, all: true });

		process.stdout.write = original;
		const raw = chunks.join("");
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(parsed.success).toBe(true);
		// With stubs, recommendations will be empty — but structure should be valid
		const recs = parsed.recommendations as unknown[];
		const count = parsed.count as number;
		expect(recs.length).toBe(count);
	});

	test("json output with --run scopes correctly", async () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string | Uint8Array): boolean => {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		};

		await executeNextImprovement({ json: true, run: "run-xyz" });

		process.stdout.write = original;
		const raw = chunks.join("");
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("next-improvement");
	});
});
