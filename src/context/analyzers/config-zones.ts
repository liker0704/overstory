import { readdir } from "node:fs/promises";
import type { ConfigZone, SignalAnalyzer } from "../types.ts";

type ZoneCategory = ConfigZone["category"];

interface ZoneEntry {
	path: string;
	category: ZoneCategory;
	isDir: boolean;
}

const ZONES: ZoneEntry[] = [
	// ci
	{ path: ".github", category: "ci", isDir: true },
	{ path: ".gitlab-ci.yml", category: "ci", isDir: false },
	{ path: ".circleci", category: "ci", isDir: true },
	{ path: "Jenkinsfile", category: "ci", isDir: false },
	{ path: ".travis.yml", category: "ci", isDir: false },
	// docker
	{ path: "Dockerfile", category: "docker", isDir: false },
	{ path: "docker-compose.yml", category: "docker", isDir: false },
	{ path: ".dockerignore", category: "docker", isDir: false },
	// config
	{ path: ".vscode", category: "config", isDir: true },
	{ path: ".idea", category: "config", isDir: true },
	{ path: ".editorconfig", category: "config", isDir: false },
	{ path: "biome.json", category: "config", isDir: false },
	{ path: ".eslintrc", category: "config", isDir: false },
	{ path: ".eslintrc.js", category: "config", isDir: false },
	{ path: ".eslintrc.json", category: "config", isDir: false },
	{ path: ".eslintrc.yml", category: "config", isDir: false },
	{ path: ".prettierrc", category: "config", isDir: false },
	{ path: ".prettierrc.js", category: "config", isDir: false },
	{ path: ".prettierrc.json", category: "config", isDir: false },
	{ path: "tsconfig.json", category: "config", isDir: false },
	// infra
	{ path: "terraform", category: "infra", isDir: true },
	{ path: "pulumi", category: "infra", isDir: true },
	{ path: "cdk", category: "infra", isDir: true },
	{ path: "k8s", category: "infra", isDir: true },
	{ path: "helm", category: "infra", isDir: true },
	// generated
	{ path: "dist", category: "generated", isDir: true },
	{ path: "build", category: "generated", isDir: true },
	{ path: "out", category: "generated", isDir: true },
	{ path: "node_modules", category: "generated", isDir: true },
	{ path: "target", category: "generated", isDir: true },
	{ path: "__pycache__", category: "generated", isDir: true },
	// docs
	{ path: "docs", category: "docs", isDir: true },
	{ path: "doc", category: "docs", isDir: true },
	{ path: "documentation", category: "docs", isDir: true },
	{ path: "README.md", category: "docs", isDir: false },
	{ path: "CHANGELOG.md", category: "docs", isDir: false },
];

async function exists(fullPath: string, isDir: boolean): Promise<boolean> {
	try {
		if (isDir) {
			await readdir(fullPath);
			return true;
		}
		return await Bun.file(fullPath).exists();
	} catch {
		return false;
	}
}

export const analyzeConfigZones: SignalAnalyzer<ConfigZone[]> = async (projectRoot) => {
	try {
		const results: ConfigZone[] = [];
		for (const zone of ZONES) {
			const fullPath = `${projectRoot}/${zone.path}`;
			if (await exists(fullPath, zone.isDir)) {
				results.push({ path: zone.path, category: zone.category });
			}
		}
		return results;
	} catch {
		return [];
	}
};
