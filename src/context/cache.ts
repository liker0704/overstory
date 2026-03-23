import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";

import type { ProjectContext } from "./types.ts";

/**
 * Compute a SHA-256 structural hash of the project's layout and key config files.
 *
 * Inputs: top-2-level directory listing (sorted), package.json, tsconfig.json,
 * and any extraInputs file contents. Parts joined with null-byte separator.
 */
export async function computeStructuralHash(
	projectRoot: string,
	extraInputs?: string[],
): Promise<string> {
	const parts: string[] = [];

	// Top-2-level directory listing
	try {
		const level1 = await readdir(projectRoot, { withFileTypes: true });
		level1.sort((a, b) => a.name.localeCompare(b.name));
		parts.push(level1.map((e) => e.name).join("\n"));

		for (const entry of level1) {
			if (entry.isDirectory()) {
				try {
					const level2 = await readdir(`${projectRoot}/${entry.name}`);
					level2.sort();
					parts.push(`${entry.name}:${level2.join("\n")}`);
				} catch {
					// skip unreadable directories
				}
			}
		}
	} catch {
		// skip on readdir failure
	}

	// package.json
	try {
		const pkg = await Bun.file(`${projectRoot}/package.json`).text();
		parts.push(pkg);
	} catch {
		// missing, skip
	}

	// tsconfig.json
	try {
		const ts = await Bun.file(`${projectRoot}/tsconfig.json`).text();
		parts.push(ts);
	} catch {
		// missing, skip
	}

	// extra inputs
	if (extraInputs) {
		for (const p of extraInputs) {
			try {
				const content = await Bun.file(p).text();
				parts.push(content);
			} catch {
				// skip missing files
			}
		}
	}

	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(parts.join("\0---\0"));
	return hasher.digest("hex");
}

/**
 * Read and parse a cached ProjectContext from disk.
 * Returns null on any error (missing file, corrupt JSON, wrong version).
 */
export function readCachedContext(cachePath: string): ProjectContext | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
		if (typeof raw !== "object" || raw === null || (raw as Record<string, unknown>).version !== 1) {
			return null;
		}
		return raw as ProjectContext;
	} catch {
		return null;
	}
}

/**
 * Write a ProjectContext to disk as JSON with 2-space indent and trailing newline.
 */
export async function writeCachedContext(
	cachePath: string,
	context: ProjectContext,
): Promise<void> {
	await Bun.write(cachePath, `${JSON.stringify(context, null, 2)}\n`);
}

/**
 * Check if a cached context is still valid for the given structural hash.
 */
export function isCacheValid(cached: ProjectContext, currentHash: string): boolean {
	return cached.version === 1 && cached.structuralHash === currentHash;
}
