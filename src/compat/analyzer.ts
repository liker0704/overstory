import type {
	CompatConfig,
	CompatibilityResult,
	ExportedSymbol,
	SurfaceChange,
	TypeSurface,
} from "./types.ts";

export interface AiFallbackOptions {
	invoke: (prompt: { system: string; user: string }) => Promise<string>;
	maxCalls?: number;
}

const DEFAULT_CONFIG: CompatConfig = {
	enabled: true,
	skipPatterns: [],
	aiThreshold: 5,
	strictMode: false,
};

function symbolKey(sym: ExportedSymbol): string {
	return `${sym.filePath}:${sym.name}`;
}

function isTypesFile(filePath: string): boolean {
	return /(?:^|\/)types\.ts$/.test(filePath);
}

/** Returns true if all props from oldSig appear in newSig (additive change). */
function isAdditiveInterfaceChange(oldSig: string, newSig: string): boolean {
	// Extract prop names from signature strings like "{ a: string; b?: number }"
	const propPattern = /(\w+)\??:/g;
	const oldProps = new Set<string>();
	// Avoid assignment-in-expression by initialising before the loop
	let m = propPattern.exec(oldSig);
	while (m !== null) {
		if (m[1] !== undefined) oldProps.add(m[1]);
		m = propPattern.exec(oldSig);
	}
	// All old props must appear in new sig
	for (const prop of oldProps) {
		const re = new RegExp(`\\b${prop}\\??:`);
		if (!re.test(newSig)) return false;
	}
	return true;
}

function classifyModification(sym: ExportedSymbol, oldSig: string): "warning" | "breaking" {
	const { kind, signature: newSig } = sym;
	if (kind === "interface" || kind === "type") {
		return isAdditiveInterfaceChange(oldSig, newSig) ? "warning" : "breaking";
	}
	if (kind === "function") {
		// Heuristic: count required params (no default, not optional)
		// param list is everything between first ( and last )
		const extractParams = (sig: string): string[] => {
			const match = /\(([^)]*)\)/.exec(sig);
			if (!match || match[1] === undefined) return [];
			return match[1]
				.split(",")
				.map((p) => p.trim())
				.filter(Boolean);
		};
		const oldParams = extractParams(oldSig);
		const newParams = extractParams(newSig);
		const isRequired = (p: string) => !p.includes("?") && !p.includes("=");
		const oldRequired = oldParams.filter(isRequired).length;
		const newRequired = newParams.filter(isRequired).length;
		if (newRequired > oldRequired) return "breaking"; // added required param
		if (newParams.length < oldParams.length) return "breaking"; // removed param
		return "warning"; // added optional param
	}
	if (kind === "const") return "warning";
	// enum, class — any change is breaking
	return "breaking";
}

const SEVERITY_ORDER: Record<string, number> = { breaking: 0, warning: 1, info: 2 };

function sortChanges(changes: SurfaceChange[]): SurfaceChange[] {
	return [...changes].sort((a, b) => {
		const sd = (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2);
		if (sd !== 0) return sd;
		return a.symbol.name.localeCompare(b.symbol.name);
	});
}

function buildSummary(changes: SurfaceChange[], compatible: boolean): string {
	const breaking = changes.filter((c) => c.severity === "breaking").length;
	const warnings = changes.filter((c) => c.severity === "warning").length;
	const additions = changes.filter((c) => c.kind === "added").length;
	if (changes.length === 0) return "No changes detected between surfaces. Surfaces are compatible.";
	const parts: string[] = [];
	if (breaking > 0) parts.push(`${breaking} breaking change${breaking > 1 ? "s" : ""}`);
	if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
	if (additions > 0) parts.push(`${additions} addition${additions > 1 ? "s" : ""}`);
	const verdict = compatible ? "Surfaces are compatible." : "Surfaces are incompatible.";
	return `Detected ${parts.join(", ")}. ${verdict}`;
}

export async function analyzeCompatibility(
	surfaceA: TypeSurface,
	surfaceB: TypeSurface,
	config?: Partial<CompatConfig>,
	aiFallback?: AiFallbackOptions,
): Promise<CompatibilityResult> {
	const cfg: CompatConfig = { ...DEFAULT_CONFIG, ...config };

	// Build lookup maps
	const mapA = new Map<string, ExportedSymbol>();
	for (const sym of surfaceA.symbols) mapA.set(symbolKey(sym), sym);
	const mapB = new Map<string, ExportedSymbol>();
	for (const sym of surfaceB.symbols) mapB.set(symbolKey(sym), sym);

	const changes: SurfaceChange[] = [];

	// Detect removals (in A but not B)
	for (const [key, sym] of mapA) {
		if (!mapB.has(key)) {
			changes.push({ kind: "removed", symbol: sym, severity: "breaking" });
		}
	}

	// Detect additions and modifications
	for (const [key, symB] of mapB) {
		const symA = mapA.get(key);
		if (symA === undefined) {
			changes.push({ kind: "added", symbol: symB, severity: "info" });
		} else if (symA.signature !== symB.signature) {
			const severity = classifyModification(symB, symA.signature);
			changes.push({
				kind: "modified",
				symbol: symB,
				previousSignature: symA.signature,
				severity,
			});
		}
	}

	// Schema conflict detection: same const in a types.ts file modified by both surfaces
	// "Modified by both" means both A and B have that symbol but with different signatures
	for (const change of changes) {
		if (
			change.kind === "modified" &&
			change.symbol.kind === "const" &&
			isTypesFile(change.symbol.filePath)
		) {
			change.severity = "breaking";
		}
	}

	const compatible = !changes.some((c) => c.severity === "breaking");
	const sorted = sortChanges(changes);

	const warningCount = sorted.filter((c) => c.severity === "warning").length;
	let staticOnly = true;
	let summary = buildSummary(sorted, compatible);

	// AI fallback: only when warnings exceed threshold
	if (aiFallback && warningCount > cfg.aiThreshold) {
		const maxCalls = aiFallback.maxCalls ?? 1;
		let callsUsed = 0;
		try {
			if (callsUsed < maxCalls) {
				callsUsed++;
				const changeLines = sorted
					.filter((c) => c.severity === "warning")
					.slice(0, maxCalls * 10)
					.map((c) => {
						const oldSig = c.previousSignature?.slice(0, 200) ?? "";
						const newSig = c.symbol.signature.slice(0, 200);
						return `- ${c.symbol.name} (${c.symbol.kind}): ${oldSig} → ${newSig}`;
					})
					.join("\n");
				const aiPrompt = {
					system:
						"You are a TypeScript compatibility analyst. Summarize the following API changes concisely.",
					user: `Branch A: ${surfaceA.ref}\nBranch B: ${surfaceB.ref}\n\nWarning-level changes:\n${changeLines}\n\nProvide a brief human-readable summary of the risk.`,
				};
				const aiSummary = await aiFallback.invoke(aiPrompt);
				summary = aiSummary.trim() || summary;
				staticOnly = false;
			}
		} catch {
			// AI failure is non-blocking — keep static summary
		}
	}

	return {
		compatible,
		changes: sorted,
		branchA: surfaceA.ref,
		branchB: surfaceB.ref,
		summary,
		staticOnly,
		analyzedAt: new Date().toISOString(),
	};
}
