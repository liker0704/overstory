import type { LanguageInfo, SignalAnalyzer } from "../types.ts";

async function fileExists(path: string): Promise<boolean> {
	try {
		await Bun.file(path).text();
		return true;
	} catch {
		return false;
	}
}

async function readTextFile(path: string): Promise<string | null> {
	try {
		return await Bun.file(path).text();
	} catch {
		return null;
	}
}

async function detectPackageManager(projectRoot: string): Promise<string | undefined> {
	if (await fileExists(`${projectRoot}/bun.lockb`)) return "bun";
	if (await fileExists(`${projectRoot}/yarn.lock`)) return "yarn";
	if (await fileExists(`${projectRoot}/pnpm-lock.yaml`)) return "pnpm";
	if (await fileExists(`${projectRoot}/package-lock.json`)) return "npm";
	return undefined;
}

function detectFramework(deps: Record<string, string>): string | undefined {
	const all = Object.keys(deps);
	if (all.includes("next")) return "next";
	if (all.includes("react")) return "react";
	if (all.includes("vue")) return "vue";
	if (all.includes("svelte")) return "svelte";
	if (all.includes("angular")) return "angular";
	if (all.includes("express")) return "express";
	if (all.includes("fastify")) return "fastify";
	if (all.includes("hono")) return "hono";
	if (all.includes("koa")) return "koa";
	if (all.includes("nestjs") || all.includes("@nestjs/core")) return "nestjs";
	if (all.includes("elysia")) return "elysia";
	return undefined;
}

async function analyzePackageJson(projectRoot: string): Promise<LanguageInfo | null> {
	const content = await readTextFile(`${projectRoot}/package.json`);
	if (!content) return null;

	let parsed: {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	try {
		parsed = JSON.parse(content) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
		};
	} catch {
		return null;
	}

	const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
	const isTypeScript = "typescript" in deps || (await fileExists(`${projectRoot}/tsconfig.json`));
	const language = isTypeScript ? "TypeScript" : "JavaScript";
	const framework = detectFramework(deps);
	const packageManager = await detectPackageManager(projectRoot);

	return {
		language,
		framework,
		packageManager,
		configFile: "package.json",
	};
}

async function analyzeCargoToml(projectRoot: string): Promise<LanguageInfo | null> {
	const content = await readTextFile(`${projectRoot}/Cargo.toml`);
	if (!content) return null;

	let framework: string | undefined;
	if (/actix/.test(content)) framework = "actix";
	else if (/rocket/.test(content)) framework = "rocket";
	else if (/axum/.test(content)) framework = "axum";
	else if (/warp/.test(content)) framework = "warp";

	return { language: "Rust", framework, configFile: "Cargo.toml" };
}

async function analyzeGoMod(projectRoot: string): Promise<LanguageInfo | null> {
	const content = await readTextFile(`${projectRoot}/go.mod`);
	if (!content) return null;

	let framework: string | undefined;
	if (/gin-gonic/.test(content)) framework = "gin";
	else if (/echo/.test(content)) framework = "echo";
	else if (/fiber/.test(content)) framework = "fiber";

	return { language: "Go", framework, configFile: "go.mod" };
}

async function analyzePython(projectRoot: string): Promise<LanguageInfo | null> {
	const hasPyproject = await fileExists(`${projectRoot}/pyproject.toml`);
	const hasSetupPy = await fileExists(`${projectRoot}/setup.py`);
	const hasRequirements = await fileExists(`${projectRoot}/requirements.txt`);

	if (!hasPyproject && !hasSetupPy && !hasRequirements) return null;

	const configFile = hasPyproject ? "pyproject.toml" : hasSetupPy ? "setup.py" : "requirements.txt";
	const content = await readTextFile(`${projectRoot}/${configFile}`);
	let framework: string | undefined;
	if (content) {
		if (/django/.test(content)) framework = "django";
		else if (/flask/.test(content)) framework = "flask";
		else if (/fastapi/.test(content)) framework = "fastapi";
	}

	return { language: "Python", framework, configFile };
}

async function analyzeRuby(projectRoot: string): Promise<LanguageInfo | null> {
	const content = await readTextFile(`${projectRoot}/Gemfile`);
	if (!content) return null;

	let framework: string | undefined;
	if (/rails/.test(content)) framework = "rails";
	else if (/sinatra/.test(content)) framework = "sinatra";

	return { language: "Ruby", framework, configFile: "Gemfile" };
}

async function analyzeJava(projectRoot: string): Promise<LanguageInfo | null> {
	const hasGradle = await fileExists(`${projectRoot}/build.gradle`);
	const hasMaven = await fileExists(`${projectRoot}/pom.xml`);
	if (!hasGradle && !hasMaven) return null;

	const configFile = hasGradle ? "build.gradle" : "pom.xml";
	const content = await readTextFile(`${projectRoot}/${configFile}`);
	let framework: string | undefined;
	if (content) {
		if (/spring/.test(content)) framework = "spring";
	}

	return { language: "Java", framework, configFile };
}

async function analyzeElixir(projectRoot: string): Promise<LanguageInfo | null> {
	const content = await readTextFile(`${projectRoot}/mix.exs`);
	if (!content) return null;

	let framework: string | undefined;
	if (/phoenix/.test(content)) framework = "phoenix";

	return { language: "Elixir", framework, configFile: "mix.exs" };
}

export const analyzeLanguages: SignalAnalyzer<LanguageInfo[]> = async (
	projectRoot: string,
): Promise<LanguageInfo[]> => {
	try {
		const analyzers = [
			analyzePackageJson(projectRoot),
			analyzeCargoToml(projectRoot),
			analyzeGoMod(projectRoot),
			analyzePython(projectRoot),
			analyzeRuby(projectRoot),
			analyzeJava(projectRoot),
			analyzeElixir(projectRoot),
		];

		const results = await Promise.all(analyzers);
		return results.filter((r): r is LanguageInfo => r !== null);
	} catch {
		return [];
	}
};

export default analyzeLanguages;
