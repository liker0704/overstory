import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPolicyDisabled } from "./kill-switch.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "ov-ks-test-"));
}

describe("isPolicyDisabled", () => {
	test("returns true when config.healthPolicy.enabled is false", () => {
		const dir = makeTempDir();
		try {
			expect(isPolicyDisabled(dir, { healthPolicy: { enabled: false } })).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("returns true when sentinel file exists", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(join(dir, "health-policy-disabled"), "");
			expect(isPolicyDisabled(dir, { healthPolicy: { enabled: true } })).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("returns true when both conditions are true", () => {
		const dir = makeTempDir();
		try {
			writeFileSync(join(dir, "health-policy-disabled"), "");
			expect(isPolicyDisabled(dir, { healthPolicy: { enabled: false } })).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("returns false when enabled is true and no sentinel", () => {
		const dir = makeTempDir();
		try {
			expect(isPolicyDisabled(dir, { healthPolicy: { enabled: true } })).toBe(false);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test("returns true when healthPolicy is undefined (not configured)", () => {
		const dir = makeTempDir();
		try {
			expect(isPolicyDisabled(dir, {})).toBe(true);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});
