// Context domain types — all types are JSON-serializable (no functions, no Date objects)

// === Signal types ===

export interface LanguageInfo {
	language: string;
	framework?: string;
	packageManager?: string;
	configFile: string;
}

export interface DirectoryProfile {
	sourceRoots: string[];
	testRoots: string[];
	zones: { path: string; category: string }[];
}

export interface NamingVocabulary {
	commonPrefixes: string[];
	conventions: { pattern: string; description: string }[];
}

export interface TestConventions {
	framework: string;
	filePattern: string;
	testRoots: string[];
	setupFiles: string[];
}

export interface ErrorPatterns {
	baseClass?: string;
	throwStyle: string;
	patterns: string[];
}

export interface ImportHotspot {
	module: string;
	importCount: number;
}

export interface ConfigZone {
	path: string;
	category: "ci" | "docker" | "config" | "infra" | "generated" | "docs";
}

export interface SharedInvariant {
	type: string;
	description: string;
	source: string;
}

// === Aggregate signal types ===

export interface ProjectSignals {
	languages: LanguageInfo[];
	directoryProfile: DirectoryProfile;
	namingVocabulary: NamingVocabulary;
	testConventions: TestConventions;
	errorPatterns: ErrorPatterns;
	importHotspots: ImportHotspot[];
	configZones: ConfigZone[];
	sharedInvariants: SharedInvariant[];
}

export interface ProjectContext {
	version: 1;
	generatedAt: string; // ISO timestamp
	structuralHash: string; // SHA-256 of structural inputs
	signals: ProjectSignals;
}

// === Analyzer and renderer interfaces ===

export type SignalAnalyzer<T> = (projectRoot: string) => Promise<T>;

export type ContextRenderer = (context: ProjectContext, opts?: { compact?: boolean }) => string;

// === Config ===

export interface ContextConfig {
	enabled?: boolean; // default true
	cachePath?: string; // default '.overstory/project-context.json'
	structuralInputs?: string[]; // extra files to include in hash
	disabledSignals?: string[]; // signal names to skip
}
