import { join } from "node:path";
import type { McpServerConfig } from "./types.ts";

/**
 * Build MCP server configuration based on available API keys.
 *
 * Checks environment for EXA_API_KEY (preferred) and BRAVE_API_KEY (fallback).
 * Returns a server map with the available providers.
 *
 * @param env - Environment record to check (defaults to process.env)
 */
export function buildMcpServers(
	env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, McpServerConfig> {
	const servers: Record<string, McpServerConfig> = {};

	const exaKey = env.EXA_API_KEY;
	const braveKey = env.BRAVE_API_KEY;

	if (exaKey) {
		servers.exa = {
			command: "npx",
			args: ["-y", "exa-mcp-server"],
			env: { EXA_API_KEY: exaKey },
		};
	} else if (braveKey) {
		servers["brave-search"] = {
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-brave-search"],
			env: { BRAVE_API_KEY: braveKey },
		};
	}

	return servers;
}

/**
 * Deploy MCP server config into the worktree's .claude/settings.local.json.
 *
 * Reads the existing file (written by hooks-deployer) and merges mcpServers
 * into it. Never overwrites existing keys — hooks and other config are preserved.
 *
 * @param worktreePath - Absolute path to the agent's git worktree
 * @param servers - MCP server map from buildMcpServers()
 */
export async function deployMcpConfig(
	worktreePath: string,
	servers: Record<string, McpServerConfig>,
): Promise<void> {
	const settingsPath = join(worktreePath, ".claude", "settings.local.json");

	let existing: Record<string, unknown> = {};
	const file = Bun.file(settingsPath);
	if (await file.exists()) {
		try {
			existing = JSON.parse(await file.text()) as Record<string, unknown>;
		} catch {
			// Malformed file — start from empty base
		}
	}

	const merged = { ...existing, mcpServers: servers };
	await Bun.write(settingsPath, `${JSON.stringify(merged, null, "\t")}\n`);
}

/**
 * Validate that at least one MCP search provider key is present.
 *
 * Returns the provider name (exa or brave) if a key is found,
 * or an error message if neither key is available.
 */
export function validateMcpKeys(): { valid: boolean; provider: string | null; error?: string } {
	if (process.env.EXA_API_KEY) {
		return { valid: true, provider: "exa" };
	}
	if (process.env.BRAVE_API_KEY) {
		return { valid: true, provider: "brave" };
	}
	return {
		valid: false,
		provider: null,
		error: "No MCP search provider key found. Set EXA_API_KEY or BRAVE_API_KEY.",
	};
}
