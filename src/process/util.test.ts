import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessRunning, tailReadLines } from "./util.ts";

// Use a PID that is almost certainly not running (max PID on Linux is 4194304)
const DEAD_PID = 4_000_000;

describe("isProcessRunning", () => {
	test("returns true for current process", () => {
		expect(isProcessRunning(process.pid)).toBe(true);
	});

	test("returns false for non-existent PID", () => {
		expect(isProcessRunning(DEAD_PID)).toBe(false);
	});
});

describe("tailReadLines", () => {
	let tmpDir: string;

	test("returns empty array for nonexistent file", async () => {
		const lines = await tailReadLines("/tmp/does-not-exist-process-util-test");
		expect(lines).toEqual([]);
	});

	test("reads all lines from a small file", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "process-util-test-"));
		const filePath = join(tmpDir, "small.txt");
		await Bun.write(filePath, "line1\nline2\nline3\n");

		const lines = await tailReadLines(filePath);
		expect(lines).toEqual(["line1", "line2", "line3"]);

		await rm(tmpDir, { recursive: true });
	});

	test("skips empty lines", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "process-util-test-"));
		const filePath = join(tmpDir, "blanks.txt");
		await Bun.write(filePath, "a\n\n  \nb\n");

		const lines = await tailReadLines(filePath);
		expect(lines).toEqual(["a", "b"]);

		await rm(tmpDir, { recursive: true });
	});

	test("truncates large files and drops first partial line", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "process-util-test-"));
		const filePath = join(tmpDir, "large.txt");

		// Write a file larger than maxBytes (use small maxBytes for test)
		const lineContent = "x".repeat(50);
		const totalLines = 100;
		const content = Array.from({ length: totalLines }, (_, i) => `${lineContent}-${i}`).join("\n");
		await Bun.write(filePath, content);

		// Use a small maxBytes so the file is truncated
		const lines = await tailReadLines(filePath, 200);
		// First line should be dropped (partial due to byte boundary)
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThan(totalLines);

		await rm(tmpDir, { recursive: true });
	});
});
