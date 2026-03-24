/**
 * Tests for src/commands/research.ts
 *
 * Uses DI to mock all runner functions — no real research sessions are started.
 * This avoids tmux/process dependencies in tests.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ResearchSession } from "../research/types.ts";
import { createResearchCommand, type ResearchDeps } from "./research.ts";

// --- Helpers ---

function makeSession(overrides: Partial<ResearchSession> = {}): ResearchSession {
	return {
		slug: "test-slug",
		topic: "test topic",
		agentName: "research-agent",
		status: "running",
		startedAt: "2026-01-01T00:00:00.000Z",
		reportPath: "/tmp/report.md",
		...overrides,
	};
}

function makeDeps(overrides: Partial<ResearchDeps> = {}): ResearchDeps {
	return {
		startResearch: async (_opts) => ({
			slug: "test-slug",
			agentName: "research-agent",
			runId: "run-1",
		}),
		stopResearch: async (_name) => {},
		getResearchStatus: async (_name) => makeSession(),
		listResearch: async () => [makeSession()],
		getResearchOutput: async (_name, _opts) => "report content",
		...overrides,
	};
}

describe("createResearchCommand", () => {
	test("returns a Command named 'research'", () => {
		const cmd = createResearchCommand(makeDeps());
		expect(cmd.name()).toBe("research");
	});

	test("has a description", () => {
		const cmd = createResearchCommand(makeDeps());
		expect(cmd.description()).toBeTruthy();
	});

	test("has 5 subcommands", () => {
		const cmd = createResearchCommand(makeDeps());
		expect(cmd.commands).toHaveLength(5);
	});

	test("has 'start' subcommand", () => {
		const cmd = createResearchCommand(makeDeps());
		const sub = cmd.commands.find((c) => c.name() === "start");
		expect(sub).toBeDefined();
	});

	test("has 'stop' subcommand", () => {
		const cmd = createResearchCommand(makeDeps());
		const sub = cmd.commands.find((c) => c.name() === "stop");
		expect(sub).toBeDefined();
	});

	test("has 'status' subcommand", () => {
		const cmd = createResearchCommand(makeDeps());
		const sub = cmd.commands.find((c) => c.name() === "status");
		expect(sub).toBeDefined();
	});

	test("has 'list' subcommand", () => {
		const cmd = createResearchCommand(makeDeps());
		const sub = cmd.commands.find((c) => c.name() === "list");
		expect(sub).toBeDefined();
	});

	test("has 'output' subcommand", () => {
		const cmd = createResearchCommand(makeDeps());
		const sub = cmd.commands.find((c) => c.name() === "output");
		expect(sub).toBeDefined();
	});
});

describe("start subcommand", () => {
	let stdoutWrites: string[];
	let stdoutSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		stdoutWrites = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdoutWrites.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	test("start subcommand has topic argument defined", () => {
		const cmd = createResearchCommand(makeDeps());
		const sub = cmd.commands.find((c) => c.name() === "start");
		const args = sub?.registeredArguments ?? [];
		const topicArg = args.find((a) => a.name() === "topic");
		expect(topicArg).toBeDefined();
	});

	test("--max-researchers option is recognized", () => {
		const cmd = createResearchCommand(makeDeps());
		const sub = cmd.commands.find((c) => c.name() === "start");
		const opt = sub?.options.find((o) => o.long === "--max-researchers");
		expect(opt).toBeDefined();
	});

	test("--json flag is recognized on start subcommand", () => {
		const cmd = createResearchCommand(makeDeps());
		const sub = cmd.commands.find((c) => c.name() === "start");
		const opt = sub?.options.find((o) => o.long === "--json");
		expect(opt).toBeDefined();
	});

	test("calls startResearch with topic and parsed maxResearchers", async () => {
		let capturedTopic: string | undefined;
		let capturedMaxResearchers: number | undefined;
		const deps = makeDeps({
			startResearch: async (opts) => {
				capturedTopic = opts.topic;
				capturedMaxResearchers = opts.maxResearchers;
				return { slug: "s", agentName: "a", runId: "r" };
			},
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["start", "my topic", "--max-researchers", "3"], {
			from: "user",
		});
		expect(capturedTopic).toBe("my topic");
		expect(capturedMaxResearchers).toBe(3);
	});

	test("prints success message on start", async () => {
		const deps = makeDeps({
			startResearch: async (_opts) => ({
				slug: "my-slug",
				agentName: "research-agent",
				runId: "r",
			}),
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["start", "my topic"], { from: "user" });
		const output = stdoutWrites.join("");
		expect(output).toContain("my-slug");
		expect(output).toContain("research-agent");
	});

	test("outputs JSON on start --json", async () => {
		const deps = makeDeps({
			startResearch: async (_opts) => ({ slug: "s", agentName: "a", runId: "r" }),
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["start", "topic", "--json"], { from: "user" });
		const output = stdoutWrites.join("");
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(true);
		expect(parsed.slug).toBe("s");
		expect(parsed.agentName).toBe("a");
	});
});

describe("stop subcommand", () => {
	let stdoutWrites: string[];
	let stdoutSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		stdoutWrites = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdoutWrites.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	test("calls stopResearch with name argument", async () => {
		let capturedName: string | undefined;
		const deps = makeDeps({
			stopResearch: async (name) => {
				capturedName = name;
			},
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["stop", "my-session"], { from: "user" });
		expect(capturedName).toBe("my-session");
	});

	test("calls stopResearch without name when omitted", async () => {
		let called = false;
		const deps = makeDeps({
			stopResearch: async (_name) => {
				called = true;
			},
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["stop"], { from: "user" });
		expect(called).toBe(true);
	});

	test("prints 'Research stopped.' on success", async () => {
		const cmd = createResearchCommand(makeDeps());
		cmd.exitOverride();
		await cmd.parseAsync(["stop"], { from: "user" });
		expect(stdoutWrites.join("")).toContain("Research stopped.");
	});

	test("outputs JSON on stop --json", async () => {
		const cmd = createResearchCommand(makeDeps());
		cmd.exitOverride();
		await cmd.parseAsync(["stop", "--json"], { from: "user" });
		const parsed = JSON.parse(stdoutWrites.join(""));
		expect(parsed.success).toBe(true);
		expect(parsed.stopped).toBe(true);
	});
});

describe("list subcommand", () => {
	let stdoutWrites: string[];
	let stdoutSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		stdoutWrites = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdoutWrites.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	test("calls listResearch", async () => {
		let called = false;
		const deps = makeDeps({
			listResearch: async () => {
				called = true;
				return [];
			},
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["list"], { from: "user" });
		expect(called).toBe(true);
	});

	test("outputs JSON array on --json", async () => {
		const session = makeSession();
		const deps = makeDeps({ listResearch: async () => [session] });
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["list", "--json"], { from: "user" });
		const parsed = JSON.parse(stdoutWrites.join(""));
		expect(parsed.success).toBe(true);
		expect(Array.isArray(parsed.sessions)).toBe(true);
		expect(parsed.sessions).toHaveLength(1);
	});

	test("prints 'No research sessions found.' when list is empty", async () => {
		const deps = makeDeps({ listResearch: async () => [] });
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["list"], { from: "user" });
		expect(stdoutWrites.join("")).toContain("No research sessions found.");
	});
});

describe("output subcommand", () => {
	let stdoutWrites: string[];
	let stdoutSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		stdoutWrites = [];
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdoutWrites.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		stdoutSpy.mockRestore();
	});

	test("calls getResearchOutput", async () => {
		let called = false;
		const deps = makeDeps({
			getResearchOutput: async (_name, _opts) => {
				called = true;
				return "hello";
			},
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["output"], { from: "user" });
		expect(called).toBe(true);
	});

	test("passes path option when --path flag is set", async () => {
		let capturedOpts: { path?: boolean } | undefined;
		const deps = makeDeps({
			getResearchOutput: async (_name, opts) => {
				capturedOpts = opts;
				return "/tmp/report.md";
			},
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["output", "--path"], { from: "user" });
		expect(capturedOpts?.path).toBe(true);
	});

	test("prints 'No research output found.' when result is null", async () => {
		const deps = makeDeps({ getResearchOutput: async () => null });
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["output"], { from: "user" });
		expect(stdoutWrites.join("")).toContain("No research output found.");
	});

	test("outputs content in JSON on --json", async () => {
		const deps = makeDeps({
			getResearchOutput: async () => "report text",
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["output", "--json"], { from: "user" });
		const parsed = JSON.parse(stdoutWrites.join(""));
		expect(parsed.success).toBe(true);
		expect(parsed.content).toBe("report text");
	});

	test("outputs path in JSON on --path --json", async () => {
		const deps = makeDeps({
			getResearchOutput: async () => "/tmp/report.md",
		});
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["output", "--path", "--json"], { from: "user" });
		const parsed = JSON.parse(stdoutWrites.join(""));
		expect(parsed.success).toBe(true);
		expect(parsed.path).toBe("/tmp/report.md");
	});

	test("outputs { found: false } in JSON when not found", async () => {
		const deps = makeDeps({ getResearchOutput: async () => null });
		const cmd = createResearchCommand(deps);
		cmd.exitOverride();
		await cmd.parseAsync(["output", "--json"], { from: "user" });
		const parsed = JSON.parse(stdoutWrites.join(""));
		expect(parsed.success).toBe(true);
		expect(parsed.found).toBe(false);
	});
});
