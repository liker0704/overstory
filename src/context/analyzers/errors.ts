import type { ErrorPatterns, SignalAnalyzer } from "../types.ts";

const MAX_FILES = 500;

export const analyzeErrorPatterns: SignalAnalyzer<ErrorPatterns> = async (projectRoot) => {
	try {
		const glob = new Bun.Glob("**/*.{ts,js,tsx,jsx}");
		const files: string[] = [];
		for await (const file of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
			if (files.length >= MAX_FILES) break;
			if (file.startsWith("node_modules/") || file.startsWith("dist/") || file.startsWith("build/"))
				continue;
			files.push(file);
		}

		const classExtends = /class\s+(\w+)\s+extends\s+(\w*Error)/g;
		const throwNew = /throw\s+new\s+(\w+)/g;
		const throwString = /throw\s+['"`]/g;

		const baseClassCounts = new Map<string, number>();
		const errorClasses = new Set<string>();
		let throwNewCount = 0;
		let throwStringCount = 0;

		for (const file of files) {
			let content: string;
			try {
				content = await Bun.file(`${projectRoot}/${file}`).text();
			} catch {
				continue;
			}

			classExtends.lastIndex = 0;
			let m = classExtends.exec(content);
			while (m !== null) {
				const name = m[1];
				const base = m[2];
				if (name !== undefined) errorClasses.add(name);
				if (base !== undefined) {
					baseClassCounts.set(base, (baseClassCounts.get(base) ?? 0) + 1);
				}
				m = classExtends.exec(content);
			}

			throwNew.lastIndex = 0;
			let tm = throwNew.exec(content);
			while (tm !== null) {
				throwNewCount++;
				tm = throwNew.exec(content);
			}

			throwString.lastIndex = 0;
			if (throwString.test(content)) throwStringCount++;
		}

		let baseClass: string | undefined;
		let maxCount = 0;
		for (const [cls, count] of baseClassCounts) {
			if (count > maxCount) {
				maxCount = count;
				baseClass = cls;
			}
		}

		let throwStyle = "new Error";
		if (throwStringCount > throwNewCount) {
			throwStyle = "throw string";
		} else if (throwNewCount > 0) {
			const hasCustom = errorClasses.size > 0;
			throwStyle = hasCustom ? "throw new CustomError" : "new Error";
		}

		return {
			baseClass,
			throwStyle,
			patterns: Array.from(errorClasses),
		};
	} catch {
		return { throwStyle: "new Error", patterns: [] };
	}
};
