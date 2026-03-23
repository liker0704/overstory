import { analyzeConfigZones } from "./analyzers/config-zones.ts";
import { analyzeDirectoryProfile } from "./analyzers/directory.ts";
import { analyzeErrorPatterns } from "./analyzers/errors.ts";
import { analyzeImportHotspots } from "./analyzers/imports.ts";
import { analyzeSharedInvariants } from "./analyzers/invariants.ts";
import { analyzeLanguages } from "./analyzers/language.ts";
import { analyzeNamingVocabulary } from "./analyzers/naming.ts";
import { analyzeTestConventions } from "./analyzers/testing.ts";
import { computeStructuralHash } from "./cache.ts";
import type {
	ConfigZone,
	DirectoryProfile,
	ErrorPatterns,
	ImportHotspot,
	LanguageInfo,
	NamingVocabulary,
	ProjectContext,
	ProjectSignals,
	SharedInvariant,
	TestConventions,
} from "./types.ts";

// Default values used when an analyzer is disabled or fails
const DEFAULT_LANGUAGES: LanguageInfo[] = [];
const DEFAULT_DIRECTORY_PROFILE: DirectoryProfile = { sourceRoots: [], testRoots: [], zones: [] };
const DEFAULT_NAMING_VOCABULARY: NamingVocabulary = { commonPrefixes: [], conventions: [] };
const DEFAULT_TEST_CONVENTIONS: TestConventions = {
	framework: "",
	filePattern: "",
	testRoots: [],
	setupFiles: [],
};
const DEFAULT_ERROR_PATTERNS: ErrorPatterns = { throwStyle: "unknown", patterns: [] };
const DEFAULT_IMPORT_HOTSPOTS: ImportHotspot[] = [];
const DEFAULT_CONFIG_ZONES: ConfigZone[] = [];
const DEFAULT_SHARED_INVARIANTS: SharedInvariant[] = [];

function getValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
	return result.status === "fulfilled" ? result.value : fallback;
}

/**
 * Analyze a project and produce a ProjectContext with all signal data.
 *
 * Runs all 8 signal analyzers in parallel. Disabled or failed analyzers
 * fall back to empty defaults — analysis is always resilient.
 */
export async function analyzeProject(
	projectRoot: string,
	opts?: { disabledSignals?: string[] },
): Promise<ProjectContext> {
	const disabled = new Set(opts?.disabledSignals ?? []);

	const [
		languagesResult,
		directoryProfileResult,
		namingVocabularyResult,
		testConventionsResult,
		errorPatternsResult,
		importHotspotsResult,
		configZonesResult,
		sharedInvariantsResult,
		structuralHashResult,
	] = await Promise.allSettled([
		disabled.has("languages") ? Promise.resolve(DEFAULT_LANGUAGES) : analyzeLanguages(projectRoot),
		disabled.has("directoryProfile")
			? Promise.resolve(DEFAULT_DIRECTORY_PROFILE)
			: analyzeDirectoryProfile(projectRoot),
		disabled.has("namingVocabulary")
			? Promise.resolve(DEFAULT_NAMING_VOCABULARY)
			: analyzeNamingVocabulary(projectRoot),
		disabled.has("testConventions")
			? Promise.resolve(DEFAULT_TEST_CONVENTIONS)
			: analyzeTestConventions(projectRoot),
		disabled.has("errorPatterns")
			? Promise.resolve(DEFAULT_ERROR_PATTERNS)
			: analyzeErrorPatterns(projectRoot),
		disabled.has("importHotspots")
			? Promise.resolve(DEFAULT_IMPORT_HOTSPOTS)
			: analyzeImportHotspots(projectRoot),
		disabled.has("configZones")
			? Promise.resolve(DEFAULT_CONFIG_ZONES)
			: analyzeConfigZones(projectRoot),
		disabled.has("sharedInvariants")
			? Promise.resolve(DEFAULT_SHARED_INVARIANTS)
			: analyzeSharedInvariants(projectRoot),
		computeStructuralHash(projectRoot),
	]);

	const signals: ProjectSignals = {
		languages: getValue(languagesResult, DEFAULT_LANGUAGES),
		directoryProfile: getValue(directoryProfileResult, DEFAULT_DIRECTORY_PROFILE),
		namingVocabulary: getValue(namingVocabularyResult, DEFAULT_NAMING_VOCABULARY),
		testConventions: getValue(testConventionsResult, DEFAULT_TEST_CONVENTIONS),
		errorPatterns: getValue(errorPatternsResult, DEFAULT_ERROR_PATTERNS),
		importHotspots: getValue(importHotspotsResult, DEFAULT_IMPORT_HOTSPOTS),
		configZones: getValue(configZonesResult, DEFAULT_CONFIG_ZONES),
		sharedInvariants: getValue(sharedInvariantsResult, DEFAULT_SHARED_INVARIANTS),
	};

	const structuralHash = getValue(structuralHashResult, "");

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		structuralHash,
		signals,
	};
}
