/**
 * Process and file utility functions shared across subsystems.
 *
 * These were extracted from watchdog internals because they are consumed
 * by 8+ unrelated modules (runtimes, commands, agents). Keeping them in
 * watchdog created a boundary leak.
 */

/**
 * Check whether a process with the given PID is still running.
 *
 * Uses signal 0 which does not kill the process -- it only checks
 * whether it exists and we have permission to signal it.
 *
 * @param pid - The process ID to check
 * @returns true if the process exists, false otherwise
 */
export function isProcessRunning(pid: number): boolean {
	try {
		// Signal 0 doesn't kill the process -- just checks if it exists
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read only the last `maxBytes` of a file and split into lines.
 * Drops the first line (likely truncated by byte boundary).
 * Safe to call on nonexistent files -- returns [].
 */
export async function tailReadLines(filePath: string, maxBytes = 100_000): Promise<string[]> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) return [];
	const size = file.size;
	const blob = size > maxBytes ? file.slice(size - maxBytes) : file;
	const text = await blob.text();
	const lines = text.split("\n").filter((l) => l.trim().length > 0);
	if (size > maxBytes) lines.shift();
	return lines;
}
