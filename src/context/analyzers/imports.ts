import type { ImportHotspot, SignalAnalyzer } from "../types.ts";

const MAX_FILES = 1000;
const TOP_N = 20;

export const analyzeImportHotspots: SignalAnalyzer<ImportHotspot[]> = async (projectRoot) => {
	try {
		const glob = new Bun.Glob("**/*.{ts,js,tsx,jsx,py,rs}");
		const files: string[] = [];
		for await (const file of glob.scan({ cwd: projectRoot, onlyFiles: true })) {
			if (files.length >= MAX_FILES) break;
			if (file.startsWith("node_modules/") || file.startsWith("dist/") || file.startsWith("build/"))
				continue;
			files.push(file);
		}

		const esImport = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
		const cjsRequire = /require\(['"]([^'"]+)['"]\)/g;
		const pyImport = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm;
		const rustUse = /^use\s+(\w+)/gm;

		const externalCounts = new Map<string, number>();
		const localCounts = new Map<string, number>();

		const isLocal = (mod: string) => mod.startsWith("./") || mod.startsWith("../");

		const bump = (mod: string) => {
			if (isLocal(mod)) {
				localCounts.set("(local)", (localCounts.get("(local)") ?? 0) + 1);
			} else {
				// normalize scoped packages and bare names
				const key = mod.startsWith("@")
					? mod.split("/").slice(0, 2).join("/")
					: (mod.split("/")[0] ?? mod);
				externalCounts.set(key, (externalCounts.get(key) ?? 0) + 1);
			}
		};

		for (const file of files) {
			let content: string;
			try {
				content = await Bun.file(`${projectRoot}/${file}`).text();
			} catch {
				continue;
			}

			esImport.lastIndex = 0;
			let m = esImport.exec(content);
			while (m !== null) {
				if (m[1] !== undefined) bump(m[1]);
				m = esImport.exec(content);
			}

			cjsRequire.lastIndex = 0;
			let cm = cjsRequire.exec(content);
			while (cm !== null) {
				if (cm[1] !== undefined) bump(cm[1]);
				cm = cjsRequire.exec(content);
			}

			if (file.endsWith(".py")) {
				pyImport.lastIndex = 0;
				let pm = pyImport.exec(content);
				while (pm !== null) {
					const mod = pm[1] ?? pm[2];
					if (mod !== undefined) externalCounts.set(mod, (externalCounts.get(mod) ?? 0) + 1);
					pm = pyImport.exec(content);
				}
			}

			if (file.endsWith(".rs")) {
				rustUse.lastIndex = 0;
				let rm = rustUse.exec(content);
				while (rm !== null) {
					if (rm[1] !== undefined) externalCounts.set(rm[1], (externalCounts.get(rm[1]) ?? 0) + 1);
					rm = rustUse.exec(content);
				}
			}
		}

		const sorted = [
			...Array.from(externalCounts.entries()).sort((a, b) => b[1] - a[1]),
			...Array.from(localCounts.entries()).sort((a, b) => b[1] - a[1]),
		]
			.slice(0, TOP_N)
			.map(([module, importCount]) => ({ module, importCount }));

		return sorted;
	} catch {
		return [];
	}
};
