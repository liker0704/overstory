import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMcpServers, deployMcpConfig, validateMcpKeys } from "./mcp.ts";

describe("buildMcpServers", () => {
	test("returns exa server when EXA_API_KEY present", () => {
		const servers = buildMcpServers({ EXA_API_KEY: "test-key-exa" });
		expect(servers.exa).toBeDefined();
		expect(servers.exa?.command).toBe("npx");
		expect(servers.exa?.env?.EXA_API_KEY).toBe("test-key-exa");
	});

	test("returns brave server when only BRAVE_API_KEY present", () => {
		const servers = buildMcpServers({ BRAVE_API_KEY: "test-key-brave" });
		expect(servers["brave-search"]).toBeDefined();
		expect(servers["brave-search"]?.command).toBe("npx");
		expect(servers["brave-search"]?.env?.BRAVE_API_KEY).toBe("test-key-brave");
	});

	test("returns empty when no keys present", () => {
		const servers = buildMcpServers({});
		expect(Object.keys(servers)).toHaveLength(0);
	});

	test("prefers exa over brave when both present", () => {
		const servers = buildMcpServers({ EXA_API_KEY: "exa-key", BRAVE_API_KEY: "brave-key" });
		expect(servers.exa).toBeDefined();
		expect(servers["brave-search"]).toBeUndefined();
	});

	test("uses correct npm package names", () => {
		const exaServers = buildMcpServers({ EXA_API_KEY: "key" });
		expect(exaServers.exa?.args).toContain("exa-mcp-server");

		const braveServers = buildMcpServers({ BRAVE_API_KEY: "key" });
		expect(braveServers["brave-search"]?.args).toContain(
			"@modelcontextprotocol/server-brave-search",
		);
	});
});

describe("deployMcpConfig", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "mcp-test-"));
		await Bun.write(join(tmpDir, ".claude", "settings.local.json"), "").catch(() => {
			// dir doesn't exist yet, that's fine
		});
	});

	afterEach(async () => {
		await rm(tmpDir, { recursive: true, force: true });
	});

	test("merges with existing settings.local.json (preserves hooks)", async () => {
		const claudeDir = join(tmpDir, ".claude");
		const settingsPath = join(claudeDir, "settings.local.json");

		const existing = {
			hooks: {
				PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo test" }] }],
			},
		};
		await Bun.write(settingsPath, JSON.stringify(existing));

		const servers = {
			exa: { command: "npx", args: ["-y", "exa-mcp-server"], env: { EXA_API_KEY: "key" } },
		};
		await deployMcpConfig(tmpDir, servers);

		const result = JSON.parse(await Bun.file(settingsPath).text()) as Record<string, unknown>;
		// Hooks preserved
		expect((result.hooks as Record<string, unknown>)?.PreToolUse).toBeDefined();
		// MCP servers added
		expect(result.mcpServers).toEqual(servers);
	});

	test("creates settings.local.json if not exists", async () => {
		const servers = {
			exa: { command: "npx", args: ["-y", "exa-mcp-server"], env: { EXA_API_KEY: "key" } },
		};
		await deployMcpConfig(tmpDir, servers);

		const settingsPath = join(tmpDir, ".claude", "settings.local.json");
		const result = JSON.parse(await Bun.file(settingsPath).text()) as Record<string, unknown>;
		expect(result.mcpServers).toEqual(servers);
	});
});

describe("validateMcpKeys", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test("returns valid=true with exa when EXA_API_KEY set", () => {
		process.env.EXA_API_KEY = "test-key";
		delete process.env.BRAVE_API_KEY;
		const result = validateMcpKeys();
		expect(result.valid).toBe(true);
		expect(result.provider).toBe("exa");
	});

	test("returns valid=false with error when no keys", () => {
		delete process.env.EXA_API_KEY;
		delete process.env.BRAVE_API_KEY;
		const result = validateMcpKeys();
		expect(result.valid).toBe(false);
		expect(result.provider).toBeNull();
		expect(result.error).toBeDefined();
	});
});
