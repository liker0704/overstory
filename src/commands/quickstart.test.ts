import { describe, expect, it } from "bun:test";
import { createQuickstartCommand } from "./quickstart.ts";

describe("createQuickstartCommand", () => {
	it("returns a Command with name 'quickstart'", () => {
		const cmd = createQuickstartCommand();
		expect(cmd.name()).toBe("quickstart");
	});

	it("has correct description", () => {
		const cmd = createQuickstartCommand();
		expect(cmd.description()).toBe("Guided first-run wizard for new users");
	});

	it("has --yes option", () => {
		const cmd = createQuickstartCommand();
		const opt = cmd.options.find((o) => o.long === "--yes");
		expect(opt).toBeDefined();
	});

	it("has --verbose option", () => {
		const cmd = createQuickstartCommand();
		const opt = cmd.options.find((o) => o.long === "--verbose");
		expect(opt).toBeDefined();
	});

	it("has --json option", () => {
		const cmd = createQuickstartCommand();
		const opt = cmd.options.find((o) => o.long === "--json");
		expect(opt).toBeDefined();
	});
});
