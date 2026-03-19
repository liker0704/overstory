/**
 * Tests for the ov ecosystem command.
 *
 * Structural tests for CLI registration, plus a smoke test that runs the
 * actual command and verifies the JSON output shape. The smoke test hits
 * real CLIs and the npm registry, so it requires network access.
 */

import { describe, expect, test } from "bun:test";
import { createEcosystemCommand, executeEcosystem } from "./ecosystem.ts";

describe("createEcosystemCommand — CLI structure", () => {
	test("command has correct name", () => {
		const cmd = createEcosystemCommand();
		expect(cmd.name()).toBe("ecosystem");
	});

	test("description mentions os-eco", () => {
		const cmd = createEcosystemCommand();
		expect(cmd.description().toLowerCase()).toContain("os-eco");
	});

	test("has --json option", () => {
		const cmd = createEcosystemCommand();
		const optionNames = cmd.options.map((o) => o.long);
		expect(optionNames).toContain("--json");
	});

	test("returns a Command instance", () => {
		const cmd = createEcosystemCommand();
		expect(typeof cmd.parse).toBe("function");
	});
});

describe("executeEcosystem — JSON output shape", () => {
	test("--json produces valid JSON with expected structure", async () => {
		// Capture stdout
		const chunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = (chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		};

		try {
			await executeEcosystem({ json: true });
		} finally {
			process.stdout.write = originalWrite;
		}

		const output = chunks.join("");
		const parsed = JSON.parse(output.trim());

		// Envelope
		expect(parsed.success).toBe(true);
		expect(parsed.command).toBe("ecosystem");

		// Tools array
		expect(Array.isArray(parsed.tools)).toBe(true);
		expect(parsed.tools.length).toBeGreaterThan(0);

		// Each tool has required fields
		for (const tool of parsed.tools) {
			expect(typeof tool.name).toBe("string");
			expect(typeof tool.cli).toBe("string");
			expect(typeof tool.npm).toBe("string");
			expect(typeof tool.installed).toBe("boolean");
		}

		// Summary
		expect(typeof parsed.summary).toBe("object");
		expect(typeof parsed.summary.total).toBe("number");
		expect(typeof parsed.summary.installed).toBe("number");
		expect(typeof parsed.summary.missing).toBe("number");
		expect(typeof parsed.summary.outdated).toBe("number");
		expect(parsed.summary.total).toBe(parsed.tools.length);
	}, 30_000); // Network calls may be slow

	test("includes overstory in tool list", async () => {
		const chunks: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = (chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		};

		try {
			await executeEcosystem({ json: true });
		} finally {
			process.stdout.write = originalWrite;
		}

		const parsed = JSON.parse(chunks.join("").trim());
		const overstory = parsed.tools.find((t: { name: string }) => t.name === "overstory");
		expect(overstory).toBeDefined();
		// In CI, `ov` may not be globally installed — only assert version when installed
		if (overstory.installed) {
			expect(overstory.version).toBeDefined();
		}
	}, 30_000);
});
