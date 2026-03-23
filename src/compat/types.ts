// Const arrays — derive union types via (typeof ARRAY)[number]
export const SYMBOL_KINDS = ["type", "interface", "function", "const", "enum", "class"] as const;
export const SURFACE_CHANGE_KINDS = ["added", "removed", "modified"] as const;
export const CHANGE_SEVERITIES = ["info", "warning", "breaking"] as const;
export const COMPAT_GATE_ACTIONS = ["admit", "defer", "reject"] as const;

// Derived union types
export type SymbolKind = (typeof SYMBOL_KINDS)[number];
export type SurfaceChangeKind = (typeof SURFACE_CHANGE_KINDS)[number];
export type ChangeSeverity = (typeof CHANGE_SEVERITIES)[number];
export type CompatGateAction = (typeof COMPAT_GATE_ACTIONS)[number];

/** One exported symbol from a TypeScript file. */
export interface ExportedSymbol {
	name: string;
	kind: SymbolKind;
	/** Serialized type signature for comparison. */
	signature: string;
	/** Repo-relative source file. */
	filePath: string;
	line: number;
}

/** Full exported surface of a branch. */
export interface TypeSurface {
	/** Git ref — branch name or commit. */
	ref: string;
	symbols: ExportedSymbol[];
	/** ISO 8601 timestamp. */
	extractedAt: string;
}

/** Detected change between two surfaces. */
export interface SurfaceChange {
	kind: SurfaceChangeKind;
	symbol: ExportedSymbol;
	/** Present when kind is modified. */
	previousSignature?: string;
	severity: ChangeSeverity;
}

/** Analyzer output. */
export interface CompatibilityResult {
	compatible: boolean;
	changes: SurfaceChange[];
	branchA: string;
	branchB: string;
	/** Human-readable explanation. */
	summary: string;
	/** Whether AI was invoked. */
	staticOnly: boolean;
	/** ISO 8601 timestamp. */
	analyzedAt: string;
}

/** Gate output. */
export interface CompatGateDecision {
	action: CompatGateAction;
	reason: string;
	result: CompatibilityResult;
}

/** Compat configuration. */
export interface CompatConfig {
	enabled: boolean;
	/** File globs to skip. */
	skipPatterns: string[];
	/** Number of warnings before AI invocation. */
	aiThreshold: number;
	/** Whether warnings block merge. */
	strictMode: boolean;
}
