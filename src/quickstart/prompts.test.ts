import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { askYesNo, printStep, printStepResult, printSummary, printWelcome } from "./prompts.ts";

// ---------------------------------------------------------------------------
// stdout capture helpers
// ---------------------------------------------------------------------------

const stdoutChunks: string[] = [];
const origWrite = process.stdout.write.bind(process.stdout);

function captureStart(): void {
	stdoutChunks.length = 0;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	}) as typeof process.stdout.write;
}

function captureStop(): string {
	process.stdout.write = origWrite;
	return stdoutChunks.join("");
}

// ---------------------------------------------------------------------------
// printStep
// ---------------------------------------------------------------------------

describe("printStep", () => {
	beforeEach(captureStart);
	afterEach(() => captureStop());

	test("includes index and total in output", () => {
		printStep(2, 7, "Installing hooks");
		const out = captureStop();
		expect(out).toContain("2/7");
	});

	test("includes title in output", () => {
		printStep(1, 3, "Checking runtime");
		const out = captureStop();
		expect(out).toContain("Checking runtime");
	});

	test("formats step 1 of 1", () => {
		printStep(1, 1, "Done");
		const out = captureStop();
		expect(out).toContain("1/1");
		expect(out).toContain("Done");
	});
});

// ---------------------------------------------------------------------------
// printStepResult
// ---------------------------------------------------------------------------

describe("printStepResult", () => {
	beforeEach(captureStart);
	afterEach(() => captureStop());

	test("complete: includes checkmark and message", () => {
		printStepResult("complete", "Hooks installed");
		const out = captureStop();
		expect(out).toContain("\u2713");
		expect(out).toContain("Hooks installed");
	});

	test("skipped: includes message", () => {
		printStepResult("skipped", "Already initialized");
		const out = captureStop();
		expect(out).toContain("Already initialized");
	});

	test("failed: includes cross and message", () => {
		printStepResult("failed", "Could not connect");
		const out = captureStop();
		expect(out).toContain("\u2717");
		expect(out).toContain("Could not connect");
	});

	test("pending: includes message", () => {
		printStepResult("pending", "Waiting for input");
		const out = captureStop();
		expect(out).toContain("Waiting for input");
	});
});

// ---------------------------------------------------------------------------
// printWelcome
// ---------------------------------------------------------------------------

describe("printWelcome", () => {
	beforeEach(captureStart);
	afterEach(() => captureStop());

	test("includes overstory brand name", () => {
		printWelcome();
		const out = captureStop();
		expect(out).toContain("overstory");
	});
});

// ---------------------------------------------------------------------------
// printSummary
// ---------------------------------------------------------------------------

describe("printSummary", () => {
	beforeEach(captureStart);
	afterEach(() => captureStop());

	test("counts complete steps", () => {
		printSummary([
			{ status: "complete" },
			{ status: "complete" },
			{ status: "skipped" },
			{ status: "failed" },
		]);
		const out = captureStop();
		expect(out).toContain("2");
	});

	test("counts skipped steps", () => {
		printSummary([{ status: "skipped" }, { status: "skipped" }]);
		const out = captureStop();
		expect(out).toContain("2");
		expect(out).toContain("skipped");
	});

	test("counts failed steps", () => {
		printSummary([{ status: "failed" }]);
		const out = captureStop();
		expect(out).toContain("failed");
	});

	test("shows 'no steps' for empty results", () => {
		printSummary([]);
		const out = captureStop();
		expect(out).toContain("no steps");
	});

	test("handles mixed results", () => {
		printSummary([
			{ status: "complete", message: "OK" },
			{ status: "skipped", message: "Skip" },
			{ status: "failed", message: "Err" },
		]);
		const out = captureStop();
		expect(out).toContain("complete");
		expect(out).toContain("skipped");
		expect(out).toContain("failed");
	});
});

// ---------------------------------------------------------------------------
// askYesNo
// ---------------------------------------------------------------------------

describe("askYesNo", () => {
	test("returns defaultYes=true when stdin is not a TTY", async () => {
		// In test environment, process.stdin.isTTY is undefined (not strictly true)
		const result = await askYesNo("Continue?", true);
		expect(result).toBe(true);
	});

	test("returns defaultYes=false when stdin is not a TTY", async () => {
		const result = await askYesNo("Continue?", false);
		expect(result).toBe(false);
	});

	test("returns false as default when defaultYes not provided", async () => {
		const result = await askYesNo("Continue?");
		expect(result).toBe(false);
	});
});
