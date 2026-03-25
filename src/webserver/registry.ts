import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ProjectEntry, ProjectRegistry } from "./types.js";

function expandTilde(p: string): string {
	if (p === "~" || p.startsWith("~/")) {
		return homedir() + p.slice(1);
	}
	return p;
}

function isProjectEntry(v: unknown): v is ProjectEntry {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.slug === "string" &&
		typeof o.name === "string" &&
		typeof o.path === "string" &&
		typeof o.addedAt === "string" &&
		typeof o.lastSeenAt === "string"
	);
}

async function readdirNames(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function isOvProject(dir: string): Promise<boolean> {
	return Bun.file(join(dir, ".overstory", "config.yaml")).exists();
}

function makeEntry(slug: string, name: string, path: string): ProjectEntry {
	const now = new Date().toISOString();
	return { slug, name, path, addedAt: now, lastSeenAt: now };
}

export async function loadRegistry(path: string): Promise<ProjectRegistry> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return { projects: [], discoveryPaths: [] };
	}
	try {
		const text = await file.text();
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) {
			return { projects: [], discoveryPaths: [] };
		}
		const obj = parsed as Record<string, unknown>;
		const projects = Array.isArray(obj.projects)
			? (obj.projects as unknown[]).filter(isProjectEntry)
			: [];
		const discoveryPaths = Array.isArray(obj.discoveryPaths)
			? (obj.discoveryPaths as unknown[]).filter((v): v is string => typeof v === "string")
			: [];
		return { projects, discoveryPaths };
	} catch {
		return { projects: [], discoveryPaths: [] };
	}
}

export async function saveRegistry(path: string, registry: ProjectRegistry): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await Bun.write(path, `${JSON.stringify(registry, null, 2)}\n`);
}

export async function discoverProjects(
	scanPaths: string[],
	options?: { maxEntries?: number },
): Promise<ProjectEntry[]> {
	const maxEntries = options?.maxEntries ?? 10000;
	const results: ProjectEntry[] = [];
	let scanned = 0;

	outer: for (const raw of scanPaths) {
		const scanDir = expandTilde(raw);
		let depth1Names: string[];
		try {
			depth1Names = await readdirNames(scanDir);
		} catch {
			continue;
		}

		for (const d1 of depth1Names) {
			if (scanned >= maxEntries) break outer;
			scanned++;
			const d1Path = join(scanDir, d1);
			if (await isOvProject(d1Path)) {
				results.push(makeEntry(d1, d1, d1Path));
			}

			let depth2Names: string[];
			try {
				depth2Names = await readdirNames(d1Path);
			} catch {
				continue;
			}

			for (const d2 of depth2Names) {
				if (scanned >= maxEntries) break outer;
				scanned++;
				const d2Path = join(d1Path, d2);
				if (await isOvProject(d2Path)) {
					results.push(makeEntry(d2, d2, d2Path));
				}
			}
		}
	}

	return results;
}

export function slugifyProject(name: string, existing: string[]): string {
	let slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");

	if (slug === "") slug = "project";

	if (!existing.includes(slug)) return slug;

	let i = 2;
	while (existing.includes(`${slug}-${i}`)) {
		i++;
	}
	return `${slug}-${i}`;
}

export async function registerProject(
	registryPath: string,
	projectPath: string,
): Promise<ProjectEntry> {
	const absPath = resolve(expandTilde(projectPath));
	const registry = await loadRegistry(registryPath);

	const existing = registry.projects.find((p) => resolve(p.path) === absPath);
	if (existing) {
		existing.lastSeenAt = new Date().toISOString();
		await saveRegistry(registryPath, registry);
		return existing;
	}

	const name = basename(absPath);
	const existingSlugs = registry.projects.map((p) => p.slug);
	const slug = slugifyProject(name, existingSlugs);
	const entry = makeEntry(slug, name, absPath);
	registry.projects.push(entry);
	await saveRegistry(registryPath, registry);
	return entry;
}

export async function refreshRegistry(
	registryPath: string,
	scanPaths: string[],
): Promise<ProjectRegistry> {
	const registry = await loadRegistry(registryPath);
	const discovered = await discoverProjects(scanPaths);
	const now = new Date().toISOString();

	for (const disc of discovered) {
		const absDiscPath = resolve(disc.path);
		const existing = registry.projects.find((p) => resolve(p.path) === absDiscPath);
		if (existing) {
			existing.lastSeenAt = now;
		} else {
			const existingSlugs = registry.projects.map((p) => p.slug);
			const slug = slugifyProject(disc.name, existingSlugs);
			registry.projects.push({ ...disc, slug, lastSeenAt: now, addedAt: now });
		}
	}

	registry.discoveryPaths = scanPaths;
	await saveRegistry(registryPath, registry);
	return registry;
}
