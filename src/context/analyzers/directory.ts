import { readdir } from "node:fs/promises";
import type { DirectoryProfile, SignalAnalyzer } from "../types.ts";

const SOURCE_ROOTS = new Set(["src", "lib", "app", "pkg", "internal"]);
const TEST_ROOTS = new Set(["test", "tests", "__tests__", "spec"]);

type ZoneCategory = "source" | "test" | "config" | "docs" | "ci" | "generated" | "infra";

function categorizeDir(name: string): ZoneCategory | null {
	const lower = name.toLowerCase();
	if (SOURCE_ROOTS.has(lower)) return "source";
	if (TEST_ROOTS.has(lower)) return "test";
	if (lower === "docs" || lower === "documentation") return "docs";
	if (lower === ".github" || lower === ".gitlab-ci" || lower === ".circleci") return "ci";
	if (lower.startsWith("docker") || lower === "infra" || lower === "terraform" || lower === "k8s")
		return "infra";
	if (lower === "dist" || lower === "build" || lower === "node_modules" || lower === ".cache")
		return "generated";
	if (
		lower === "config" ||
		lower === "configs" ||
		lower === ".overstory" ||
		lower === ".claude" ||
		lower.endsWith(".json") ||
		lower.endsWith(".yaml") ||
		lower.endsWith(".toml")
	)
		return "config";
	return null;
}

export const analyzeDirectoryProfile: SignalAnalyzer<DirectoryProfile> = async (
	projectRoot: string,
): Promise<DirectoryProfile> => {
	const sourceRoots: string[] = [];
	const testRoots: string[] = [];
	const zones: { path: string; category: string }[] = [];

	try {
		const topLevel = await readdir(projectRoot, { withFileTypes: true });
		const dirs = topLevel.filter((d) => d.isDirectory());

		for (const dir of dirs) {
			const name = dir.name;
			const category = categorizeDir(name);
			if (!category) continue;

			if (category === "source") sourceRoots.push(name);
			else if (category === "test") testRoots.push(name);
			zones.push({ path: name, category });

			// Scan one more level for source/test sub-dirs
			if (category === "source" || category === "test") {
				try {
					const subEntries = await readdir(`${projectRoot}/${name}`, { withFileTypes: true });
					const subDirs = subEntries.filter((d) => d.isDirectory());
					for (const sub of subDirs) {
						const subCategory = categorizeDir(sub.name);
						if (subCategory === "test" && !testRoots.includes(`${name}/${sub.name}`)) {
							testRoots.push(`${name}/${sub.name}`);
							zones.push({ path: `${name}/${sub.name}`, category: "test" });
						}
					}
				} catch {
					// ignore unreadable subdirs
				}
			}
		}
	} catch {
		// return empty profile on failure
	}

	return { sourceRoots, testRoots, zones };
};

export default analyzeDirectoryProfile;
