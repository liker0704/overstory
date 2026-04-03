/**
 * Tests for mission mail-bridge utilities.
 *
 * Focuses on parseMissionFindingPayload (pure function) and
 * basic smoke tests for the async store-backed functions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { parseMissionFindingPayload } from "./mail-bridge.ts";

// ============================================================
// parseMissionFindingPayload
// ============================================================

describe("parseMissionFindingPayload", () => {
	function validPayload() {
		return {
			workstreamId: "ws-001",
			category: "cross-stream",
			summary: "Something important happened",
			affectedWorkstreams: ["ws-001", "ws-002"],
		};
	}

	test("returns parsed payload for valid JSON string", () => {
		const raw = JSON.stringify(validPayload());
		const result = parseMissionFindingPayload(raw);

		expect(result.workstreamId).toBe("ws-001");
		expect(result.category).toBe("cross-stream");
		expect(result.summary).toBe("Something important happened");
		expect(result.affectedWorkstreams).toEqual(["ws-001", "ws-002"]);
	});

	test("throws ValidationError when rawPayload is undefined", () => {
		expect(() => parseMissionFindingPayload(undefined)).toThrow(ValidationError);
	});

	test("throws ValidationError when rawPayload is empty string", () => {
		expect(() => parseMissionFindingPayload("")).toThrow(ValidationError);
	});

	test("throws ValidationError when rawPayload is invalid JSON", () => {
		expect(() => parseMissionFindingPayload("not-json{")).toThrow(ValidationError);
	});

	test("throws ValidationError when payload is a JSON array instead of object", () => {
		expect(() => parseMissionFindingPayload('["ws-001"]')).toThrow(ValidationError);
	});

	test("throws ValidationError when workstreamId is missing", () => {
		const payload = { ...validPayload(), workstreamId: undefined };
		expect(() => parseMissionFindingPayload(JSON.stringify(payload))).toThrow(ValidationError);
	});

	test("throws ValidationError when workstreamId is empty string", () => {
		const payload = { ...validPayload(), workstreamId: "   " };
		expect(() => parseMissionFindingPayload(JSON.stringify(payload))).toThrow(ValidationError);
	});

	test("throws ValidationError when category is missing", () => {
		const payload = { ...validPayload(), category: undefined };
		expect(() => parseMissionFindingPayload(JSON.stringify(payload))).toThrow(ValidationError);
	});

	test("throws ValidationError when summary is missing", () => {
		const payload = { ...validPayload(), summary: undefined };
		expect(() => parseMissionFindingPayload(JSON.stringify(payload))).toThrow(ValidationError);
	});

	test("throws ValidationError when affectedWorkstreams is not an array", () => {
		const payload = { ...validPayload(), affectedWorkstreams: "ws-001" };
		expect(() => parseMissionFindingPayload(JSON.stringify(payload))).toThrow(ValidationError);
	});

	test("throws ValidationError when affectedWorkstreams contains non-strings", () => {
		const payload = { ...validPayload(), affectedWorkstreams: [1, 2] };
		expect(() => parseMissionFindingPayload(JSON.stringify(payload))).toThrow(ValidationError);
	});

	test("ValidationError has VALIDATION_ERROR code", () => {
		try {
			parseMissionFindingPayload(undefined);
			expect(true).toBe(false); // should not reach here
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			expect((err as ValidationError).code).toBe("VALIDATION_ERROR");
		}
	});

	test("accepts empty affectedWorkstreams array", () => {
		const payload = { ...validPayload(), affectedWorkstreams: [] };
		const result = parseMissionFindingPayload(JSON.stringify(payload));
		expect(result.affectedWorkstreams).toEqual([]);
	});
});

// ============================================================
// checkMissionFreezeTimeouts — smoke test with real temp dir
// ============================================================

describe("checkMissionFreezeTimeouts", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "ov-mail-bridge-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("returns without error when no sessions.db exists", async () => {
		// Write a minimal config.yaml so loadConfig does not throw
		await Bun.write(join(tempDir, ".overstory", "config.yaml"), "version: 1\n");
		const { checkMissionFreezeTimeouts } = await import("./mail-bridge.ts");
		// No sessions.db — function should complete without throwing
		await expect(checkMissionFreezeTimeouts(tempDir)).resolves.toBeUndefined();
	});
});
