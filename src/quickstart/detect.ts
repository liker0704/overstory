/**
 * State detection helpers for the quickstart wizard.
 *
 * Each function inspects the local environment to determine whether
 * a prerequisite or setup step has already been completed.
 */

/** Check whether overstory has been initialized in the given project root. */
export async function isInitialized(projectRoot: string): Promise<boolean> {
	return Bun.file(`${projectRoot}/.overstory/config.yaml`).exists();
}

/**
 * Check whether overstory hooks are installed.
 *
 * Requires both `.overstory/hooks.json` and `.claude/settings.local.json`
 * containing an overstory reference.
 */
export async function areHooksInstalled(projectRoot: string): Promise<boolean> {
	const hooksExists = await Bun.file(`${projectRoot}/.overstory/hooks.json`).exists();
	if (!hooksExists) return false;

	const settingsPath = `${projectRoot}/.claude/settings.local.json`;
	const settingsExists = await Bun.file(settingsPath).exists();
	if (!settingsExists) return false;

	const content = await Bun.file(settingsPath).text();
	return content.includes("overstory");
}

interface DoctorJsonOutput {
	success: boolean;
	command: string;
	checks: Array<{ name: string; status: "pass" | "warn" | "fail" }>;
	summary: { pass: number; warn: number; fail: number };
}

/**
 * Check whether required CLI dependencies are available.
 *
 * Runs `ov doctor --category dependencies --json` and parses the result.
 * Returns `{ ok: true, missing: [] }` on any parse or execution failure
 * to avoid blocking the wizard on transient errors.
 */
export async function areDependenciesAvailable(): Promise<{ ok: boolean; missing: string[] }> {
	try {
		const proc = Bun.spawn(["ov", "doctor", "--category", "dependencies", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

		if (exitCode !== 0) {
			return { ok: false, missing: [] };
		}

		const result = JSON.parse(stdout) as DoctorJsonOutput;
		const missing = result.checks.filter((c) => c.status === "fail").map((c) => c.name);

		return { ok: missing.length === 0, missing };
	} catch {
		return { ok: false, missing: [] };
	}
}

/**
 * Check whether a runtime API key is available.
 *
 * Currently checks ANTHROPIC_API_KEY. Returns true when the variable
 * is set and non-empty.
 */
export async function isRuntimeAvailable(): Promise<boolean> {
	const key = process.env.ANTHROPIC_API_KEY;
	return typeof key === "string" && key.length > 0;
}

interface StatusJsonOutput {
	success: boolean;
	agents: Array<{ state: string }>;
}

/**
 * Check whether any agents are currently active.
 *
 * Runs `ov status --json` and looks for non-zombie, non-completed agents.
 * Returns false on any error or if the command is unavailable.
 */
export async function hasActiveAgents(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["ov", "status", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

		if (exitCode !== 0) return false;

		const result = JSON.parse(stdout) as StatusJsonOutput;
		if (!Array.isArray(result.agents)) return false;

		return result.agents.some((a) => a.state !== "zombie" && a.state !== "completed");
	} catch {
		return false;
	}
}
