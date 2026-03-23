import { createEventStore } from "../events/store.ts";
import type { MergeEntry } from "../merge/types.ts";
import { analyzeCompatibility } from "./analyzer.ts";
import { extractTypeSurface } from "./extractor.ts";
import type {
	CompatConfig,
	CompatGateDecision,
	CompatibilityResult,
	TypeSurface,
} from "./types.ts";

// Branch name validation regex (defense in depth)
const BRANCH_PATTERN = /^[a-zA-Z0-9/_.-]+$/;

// Default file patterns for type surface extraction
const DEFAULT_FILE_PATTERNS = ["src/**/*.ts"];

/** Cache interface for canonical surface (shared across entries in --all mode). */
interface SurfaceCache {
	get(key: string): TypeSurface | undefined;
	set(key: string, surface: TypeSurface): void;
}

export function createSurfaceCache(): SurfaceCache {
	const cache = new Map<string, TypeSurface>();
	return { get: (k) => cache.get(k), set: (k, v) => cache.set(k, v) };
}

/** Dependency injection interface for testability. */
interface GateDeps {
	extractSurface: typeof extractTypeSurface;
	analyze: typeof analyzeCompatibility;
	/** Resolve a git ref to a commit SHA. Returns empty string on failure. */
	gitRevParse: (repoRoot: string, ref: string) => Promise<string>;
}

async function defaultGitRevParse(
	repoRoot: string,
	ref: string,
): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", ref], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	await proc.exited;
	return (await new Response(proc.stdout).text()).trim();
}

/** Check if a file path matches any of the given glob patterns. */
function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	return patterns.some((pattern) => {
		const regexStr = pattern
			.replace(/\./g, "\\.")
			.replace(/\*\*/g, ".*")
			.replace(/\*/g, "[^/]*")
			.replace(/\?/g, "[^/]");
		return new RegExp(`^${regexStr}$`).test(filePath);
	});
}

/** Build a minimal CompatibilityResult for early-exit cases. */
function earlyAdmitResult(
	branchA: string,
	branchB: string,
	summary: string,
): CompatibilityResult {
	return {
		compatible: true,
		changes: [],
		branchA,
		branchB,
		summary,
		staticOnly: true,
		analyzedAt: new Date().toISOString(),
	};
}

/**
 * Run the compatibility gate for a merge entry.
 *
 * Returns a gate decision: admit, defer, or reject.
 * - admit: proceed with merge tiers
 * - defer: incompatible but non-strict mode (warn, continue)
 * - reject: incompatible and strict mode (block merge)
 */
export async function runCompatGate(
	repoRoot: string,
	entry: MergeEntry,
	canonicalBranch: string,
	config: CompatConfig,
	options?: {
		surfaceCache?: SurfaceCache;
		eventsDbPath?: string;
		_deps?: GateDeps;
	},
): Promise<CompatGateDecision> {
	const deps: GateDeps = options?._deps ?? {
		extractSurface: extractTypeSurface,
		analyze: analyzeCompatibility,
		gitRevParse: defaultGitRevParse,
	};

	// 1. Gate disabled — admit immediately without analysis
	if (!config.enabled) {
		const result = earlyAdmitResult(
			canonicalBranch,
			entry.branchName,
			"compat gate disabled",
		);
		return { action: "admit", reason: "compat gate disabled", result };
	}

	// 2. All modified files match skip patterns — admit early
	const files = entry.filesModified;
	if (
		files.length > 0 &&
		config.skipPatterns.length > 0 &&
		files.every((f) => matchesAnyPattern(f, config.skipPatterns))
	) {
		const result = earlyAdmitResult(
			canonicalBranch,
			entry.branchName,
			"all modified files match skip patterns",
		);
		return {
			action: "admit",
			reason: "all modified files match skip patterns",
			result,
		};
	}

	// 3. Validate branch name
	if (
		!BRANCH_PATTERN.test(entry.branchName) ||
		entry.branchName.includes("..")
	) {
		throw new Error(`Invalid branch name: "${entry.branchName}"`);
	}

	// 4. Get canonical commit SHA for cache key
	const canonicalSha = await deps.gitRevParse(repoRoot, canonicalBranch);

	// 5. Check cache for canonical surface; extract if miss
	const cache = options?.surfaceCache;
	const cacheHit = cache?.get(canonicalSha);
	let canonicalSurface: TypeSurface;
	if (cacheHit !== undefined) {
		canonicalSurface = cacheHit;
	} else {
		canonicalSurface = await deps.extractSurface(
			repoRoot,
			canonicalBranch,
			DEFAULT_FILE_PATTERNS,
		);
		cache?.set(canonicalSha, canonicalSurface);
	}

	// 6. Extract type surface for entry branch
	const branchSurface = await deps.extractSurface(
		repoRoot,
		entry.branchName,
		DEFAULT_FILE_PATTERNS,
	);

	// 7. Run analyzeCompatibility
	const result = await deps.analyze(canonicalSurface, branchSurface, config);

	// 8. Build decision
	let action: CompatGateDecision["action"];
	if (result.compatible) {
		action = "admit";
	} else if (config.strictMode) {
		action = "reject";
	} else {
		action = "defer";
	}

	const decision: CompatGateDecision = {
		action,
		reason: result.summary,
		result,
	};

	// 9. Emit event to events.db if eventsDbPath provided
	if (options?.eventsDbPath) {
		try {
			const eventStore = createEventStore(options.eventsDbPath);
			eventStore.insert({
				agentName: "compat-gate",
				runId: null,
				sessionId: null,
				eventType: "custom",
				toolName: null,
				toolArgs: null,
				toolDurationMs: null,
				level: action === "reject" ? "warn" : "info",
				data: JSON.stringify(decision),
			});
			eventStore.close();
		} catch {
			// Event emission failure is non-blocking
		}
	}

	return decision;
}
