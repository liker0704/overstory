import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ValidationError } from "../errors.ts";
import { createSessionStore } from "../sessions/store.ts";
import type { AgentSession } from "../types.ts";
import {
	listResearch,
	resolveUniqueSlug,
	slugifyTopic,
	startResearch,
	validateMaxResearchers,
} from "./runner.ts";

// === Helpers ===

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "overstory-runner-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		id: "session-test-1",
		agentName: "research-my-topic",
		capability: "research-lead",
		runtime: "claude",
		worktreePath: "/proj",
		branchName: "main",
		taskId: "research-my-topic",
		tmuxSession: "overstory-research-my-topic",
		state: "working",
		pid: 1234,
		parentAgent: null,
		depth: 0,
		runId: "run-test-1",
		startedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		escalationLevel: 0,
		stalledSince: null,
		rateLimitedSince: null,
		runtimeSessionId: null,
		transcriptPath: null,
		originalRuntime: null,
		statusLine: null,
		...overrides,
	};
}

// === slugifyTopic ===

describe("slugifyTopic", () => {
	test("basic lowercase and hyphenation", () => {
		expect(slugifyTopic("Hello World")).toBe("hello-world");
	});

	test("strips special characters", () => {
		expect(slugifyTopic("Special @#$ chars!")).toBe("special-chars");
	});

	test("strips non-ascii unicode", () => {
		const result = slugifyTopic("Привет мир hello");
		// Non-ascii stripped, spaces become hyphens
		expect(result).toBe("hello");
	});

	test("truncates long topics to 60 chars", () => {
		const topic = "a".repeat(80);
		const result = slugifyTopic(topic);
		expect(result.length).toBeLessThanOrEqual(60);
	});

	test("trims trailing hyphen after truncation", () => {
		// Construct a topic where the 60th char falls on a hyphen boundary
		// 58 a's + space + more text = "aaa...aaa-more-text", truncated at 60 leaves trailing hyphen
		const topic = `${"a".repeat(58)} b c d e f g h i j k l m n`;
		const result = slugifyTopic(topic);
		expect(result.endsWith("-")).toBe(false);
	});

	test("collapses multiple hyphens", () => {
		expect(slugifyTopic("hello   world")).toBe("hello-world");
	});

	test("trims leading and trailing hyphens", () => {
		expect(slugifyTopic("  hello world  ")).toBe("hello-world");
	});
});

// === resolveUniqueSlug ===

describe("resolveUniqueSlug", () => {
	test("returns baseSlug when no collision", async () => {
		const outputBase = join(tempDir, "research");
		await mkdir(outputBase, { recursive: true });
		expect(resolveUniqueSlug("my-topic", outputBase)).toBe("my-topic");
	});

	test("appends -2 on first collision", async () => {
		const outputBase = join(tempDir, "research");
		await mkdir(join(outputBase, "my-topic"), { recursive: true });
		expect(resolveUniqueSlug("my-topic", outputBase)).toBe("my-topic-2");
	});

	test("appends -3 when -2 also exists", async () => {
		const outputBase = join(tempDir, "research");
		await mkdir(join(outputBase, "my-topic"), { recursive: true });
		await mkdir(join(outputBase, "my-topic-2"), { recursive: true });
		expect(resolveUniqueSlug("my-topic", outputBase)).toBe("my-topic-3");
	});
});

// === validateMaxResearchers ===

describe("validateMaxResearchers", () => {
	test("passes through valid value", () => {
		expect(validateMaxResearchers(5)).toBe(5);
	});

	test("clamps 0 to 1", () => {
		expect(validateMaxResearchers(0)).toBe(1);
	});

	test("clamps 50 to 20", () => {
		expect(validateMaxResearchers(50)).toBe(20);
	});

	test("rounds fractional values", () => {
		expect(validateMaxResearchers(3.7)).toBe(4);
	});
});

// === startResearch — MCP validation gate ===

describe("startResearch", () => {
	test("throws ValidationError when no MCP keys are set", async () => {
		// Save and clear MCP keys from env
		const savedExa = process.env.EXA_API_KEY;
		const savedBrave = process.env.BRAVE_API_KEY;
		delete process.env.EXA_API_KEY;
		delete process.env.BRAVE_API_KEY;

		try {
			await expect(startResearch({ topic: "test topic" })).rejects.toThrow(ValidationError);
		} finally {
			if (savedExa !== undefined) process.env.EXA_API_KEY = savedExa;
			if (savedBrave !== undefined) process.env.BRAVE_API_KEY = savedBrave;
		}
	});

	test("calls validateMcpKeys before any side effects", async () => {
		const savedExa = process.env.EXA_API_KEY;
		const savedBrave = process.env.BRAVE_API_KEY;
		delete process.env.EXA_API_KEY;
		delete process.env.BRAVE_API_KEY;

		// Verify the error is thrown before any filesystem effects
		const outputBase = join(tempDir, "research");

		try {
			await expect(startResearch({ topic: "test topic" })).rejects.toThrow(ValidationError);
			// Verify no research directory was created (no side effects)
			expect(existsSync(outputBase)).toBe(false);
		} finally {
			if (savedExa !== undefined) process.env.EXA_API_KEY = savedExa;
			if (savedBrave !== undefined) process.env.BRAVE_API_KEY = savedBrave;
		}
	});
});

// === listResearch — filters by research-lead capability ===

describe("listResearch", () => {
	test("filters sessions by research-lead capability", async () => {
		const overstoryDir = join(tempDir, ".overstory");
		await mkdir(overstoryDir, { recursive: true });
		const dbPath = join(overstoryDir, "sessions.db");

		// Insert sessions with different capabilities
		const store = createSessionStore(dbPath);
		try {
			store.upsert(
				makeSession({ id: "s1", agentName: "research-topic-a", capability: "research-lead" }),
			);
			store.upsert(makeSession({ id: "s2", agentName: "coordinator", capability: "coordinator" }));
			store.upsert(
				makeSession({ id: "s3", agentName: "research-topic-b", capability: "research-lead" }),
			);
		} finally {
			store.close();
		}

		// Mock process.cwd to return our temp dir's parent
		const origCwd = process.cwd;
		// listResearch calls loadConfig(process.cwd()), which calls resolveProjectRoot
		// We need .overstory/config.yaml to exist for loadConfig to find the project root
		await mkdir(join(tempDir, ".overstory"), { recursive: true });
		// Write a minimal config.yaml
		await Bun.write(
			join(tempDir, ".overstory", "config.yaml"),
			`project:\n  name: test\n  root: ${tempDir}\n  canonicalBranch: main\n`,
		);

		process.cwd = () => tempDir;
		try {
			const results = await listResearch();
			const names = results.map((r) => r.agentName);
			expect(names).toContain("research-topic-a");
			expect(names).toContain("research-topic-b");
			expect(names).not.toContain("coordinator");
		} finally {
			process.cwd = origCwd;
		}
	});
});
