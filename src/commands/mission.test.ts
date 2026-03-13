import { describe, expect, test } from "bun:test";
import { createMissionCommand } from "./mission.ts";

describe("createMissionCommand", () => {
	test("returns a command named 'mission'", () => {
		const cmd = createMissionCommand();
		expect(cmd.name()).toBe("mission");
	});

	test("has mission lifecycle subcommands", () => {
		const cmd = createMissionCommand();
		const names = cmd.commands.map((command) => command.name());

		expect(names).toContain("start");
		expect(names).toContain("status");
		expect(names).toContain("output");
		expect(names).toContain("answer");
		expect(names).toContain("artifacts");
		expect(names).toContain("handoff");
		expect(names).toContain("complete");
		expect(names).toContain("stop");
		expect(names).toContain("list");
		expect(names).toContain("show");
		expect(names).toContain("bundle");
		expect(names).toHaveLength(11);
	});

	test("answer subcommand supports --body and --file", () => {
		const cmd = createMissionCommand();
		const answer = cmd.commands.find((command) => command.name() === "answer");
		const options = answer?.options ?? [];

		expect(options.find((option) => option.long === "--body")).toBeDefined();
		expect(options.find((option) => option.long === "--file")).toBeDefined();
		expect(options.find((option) => option.long === "--json")).toBeDefined();
	});

	test("bundle subcommand supports mission selection and force", () => {
		const cmd = createMissionCommand();
		const bundle = cmd.commands.find((command) => command.name() === "bundle");
		const options = bundle?.options ?? [];

		expect(options.find((option) => option.long === "--mission-id")).toBeDefined();
		expect(options.find((option) => option.long === "--force")).toBeDefined();
		expect(options.find((option) => option.long === "--json")).toBeDefined();
	});
});
