const DEFAULT_TIMEOUT_MS = 10_000;
const MISSION_START_TIMEOUT_MS = 30_000;

export interface CommandResult {
	success: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface ActionResult {
	success: boolean;
	output: string;
	error?: string;
}

export async function executeOvCommand(
	projectPath: string,
	args: string[],
	timeoutMs?: number,
): Promise<CommandResult> {
	const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const proc = Bun.spawn(["ov", ...args], {
		cwd: projectPath,
		stdout: "pipe",
		stderr: "pipe",
	});

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				proc.kill();
				reject(new Error(`Command timed out after ${timeout}ms`));
			}, timeout);
		});

		const resultPromise = (async () => {
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			const exitCode = await proc.exited;
			return { stdout, stderr, exitCode };
		})();

		const { stdout, stderr, exitCode } = await Promise.race([resultPromise, timeoutPromise]);
		return { success: exitCode === 0, stdout, stderr, exitCode };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { success: false, stdout: "", stderr: msg, exitCode: -1 };
	} finally {
		clearTimeout(timer);
	}
}

export async function missionStart(
	projectPath: string,
	params: { slug?: string; objective?: string },
): Promise<ActionResult> {
	const args = ["mission", "start", "--no-attach", "--json"];
	if (params.slug !== undefined) {
		args.push("--slug", params.slug);
	}
	if (params.objective !== undefined) {
		args.push("--objective", params.objective);
	}
	const result = await executeOvCommand(projectPath, args, MISSION_START_TIMEOUT_MS);
	if (result.success) {
		return { success: true, output: result.stdout };
	}
	return { success: false, output: result.stdout, error: result.stderr };
}

export async function missionAction(
	projectPath: string,
	action: "pause" | "resume" | "stop",
): Promise<ActionResult> {
	const args =
		action === "stop" ? ["mission", "stop", "--kill", "--json"] : ["mission", action, "--json"];
	const result = await executeOvCommand(projectPath, args);
	if (result.success) {
		return { success: true, output: result.stdout };
	}
	return { success: false, output: result.stdout, error: result.stderr };
}

export async function missionAnswer(projectPath: string, text: string): Promise<ActionResult> {
	const args = ["mission", "answer", "--text", text, "--json"];
	const result = await executeOvCommand(projectPath, args);
	if (result.success) {
		return { success: true, output: result.stdout };
	}
	return { success: false, output: result.stdout, error: result.stderr };
}
