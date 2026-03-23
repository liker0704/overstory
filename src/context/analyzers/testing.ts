import type { SignalAnalyzer, TestConventions } from "../types.ts";

const TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/test_*.*", "**/*_test.*"];

const SETUP_PATTERNS = [
	"jest.setup.*",
	"setupTests.*",
	"vitest.setup.*",
	"conftest.py",
	"test_helper.*",
	"spec_helper.*",
];

const TEST_ROOT_NAMES = new Set(["test", "tests", "__tests__", "spec"]);

async function readTextFile(path: string): Promise<string | null> {
	try {
		return await Bun.file(path).text();
	} catch {
		return null;
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await Bun.file(path).text();
		return true;
	} catch {
		return false;
	}
}

async function detectFramework(projectRoot: string): Promise<string> {
	// 1. Check explicit config files first
	if (await fileExists(`${projectRoot}/jest.config.js`)) return "jest";
	if (await fileExists(`${projectRoot}/jest.config.ts`)) return "jest";
	if (await fileExists(`${projectRoot}/jest.config.mjs`)) return "jest";
	if (await fileExists(`${projectRoot}/vitest.config.ts`)) return "vitest";
	if (await fileExists(`${projectRoot}/vitest.config.js`)) return "vitest";
	if (await fileExists(`${projectRoot}/pytest.ini`)) return "pytest";
	if (await fileExists(`${projectRoot}/conftest.py`)) return "pytest";

	// 2. Check package.json scripts/deps
	const pkgContent = await readTextFile(`${projectRoot}/package.json`);
	if (pkgContent) {
		const pkg = JSON.parse(pkgContent) as {
			scripts?: Record<string, string>;
			devDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		const scripts = pkg.scripts ?? {};
		const devDeps = pkg.devDependencies ?? {};
		const deps = pkg.dependencies ?? {};
		const allDeps = { ...devDeps, ...deps };

		if (scripts.test?.includes("bun test") || scripts.test?.includes("bun:test")) return "bun:test";
		if ("jest" in allDeps) return "jest";
		if ("vitest" in allDeps) return "vitest";
		if ("mocha" in allDeps) return "mocha";
		if ("jasmine" in allDeps) return "jasmine";
	}

	// 3. Check Cargo.toml for Rust test frameworks
	const cargoContent = await readTextFile(`${projectRoot}/Cargo.toml`);
	if (cargoContent) {
		if (/\[dev-dependencies\]/.test(cargoContent)) {
			if (/mockall|tokio-test|proptest/.test(cargoContent)) return "rust-test";
		}
	}

	// 4. Check pyproject.toml
	const pyprojectContent = await readTextFile(`${projectRoot}/pyproject.toml`);
	if (pyprojectContent && /pytest/.test(pyprojectContent)) return "pytest";

	return "unknown";
}

function extractTestRoots(filePaths: string[]): string[] {
	const roots = new Set<string>();
	for (const fp of filePaths) {
		const parts = fp.split("/");
		if (parts[0] && TEST_ROOT_NAMES.has(parts[0])) {
			roots.add(parts[0]);
		} else if (parts[1] && TEST_ROOT_NAMES.has(parts[1]) && parts[0]) {
			roots.add(`${parts[0]}/${parts[1]}`);
		}
	}
	return [...roots];
}

function dominantPattern(filePaths: string[]): string {
	const counts = new Map<string, number>();
	for (const fp of filePaths) {
		if (/\.test\.[a-z]+$/.test(fp)) counts.set("*.test.*", (counts.get("*.test.*") ?? 0) + 1);
		else if (/\.spec\.[a-z]+$/.test(fp)) counts.set("*.spec.*", (counts.get("*.spec.*") ?? 0) + 1);
		else if (/\/test_[^/]+$/.test(fp)) counts.set("test_*.*", (counts.get("test_*.*") ?? 0) + 1);
		else if (/_test\.[a-z]+$/.test(fp)) counts.set("*_test.*", (counts.get("*_test.*") ?? 0) + 1);
	}

	let best = "";
	let bestCount = 0;
	for (const [pattern, count] of counts.entries()) {
		if (count > bestCount) {
			bestCount = count;
			best = pattern;
		}
	}
	return best || "*.test.*";
}

export const analyzeTestConventions: SignalAnalyzer<TestConventions> = async (
	projectRoot: string,
): Promise<TestConventions> => {
	const foundFiles: string[] = [];

	try {
		for (const globPattern of TEST_GLOBS) {
			const g = new Bun.Glob(globPattern);
			for await (const file of g.scan({ cwd: projectRoot, onlyFiles: true })) {
				if (
					file.includes("node_modules") ||
					file.includes(".git") ||
					file.includes("dist/") ||
					file.includes("build/")
				)
					continue;
				foundFiles.push(file);
			}
		}
	} catch {
		// ignore scan errors
	}

	const framework = await detectFramework(projectRoot);
	const filePattern = dominantPattern(foundFiles);
	const testRoots = extractTestRoots(foundFiles);

	// Find setup files
	const setupFiles: string[] = [];
	for (const pattern of SETUP_PATTERNS) {
		const g = new Bun.Glob(pattern);
		try {
			for await (const file of g.scan({ cwd: projectRoot, onlyFiles: true })) {
				setupFiles.push(file);
			}
		} catch {
			// ignore
		}
	}

	return { framework, filePattern, testRoots, setupFiles };
};

export default analyzeTestConventions;
