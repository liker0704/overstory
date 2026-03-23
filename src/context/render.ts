import type { ProjectContext } from "./types.ts";

/**
 * Render a ProjectContext as markdown.
 * Default (compact) mode produces a concise bullet summary < 2KB.
 * Full mode produces a detailed breakdown by signal category.
 */
export function renderContext(context: ProjectContext, opts?: { compact?: boolean }): string {
	const compact = opts?.compact !== false;
	return compact ? renderCompact(context) : renderFull(context);
}

function renderCompact(context: ProjectContext): string {
	const { signals } = context;
	const lines: string[] = ["## Project Context", ""];

	// Languages
	const langNames = signals.languages.map((l) => {
		let name = l.language;
		if (l.framework) name += ` (${l.framework})`;
		return name;
	});
	if (langNames.length > 0) {
		lines.push(`- **Languages:** ${langNames.join(", ")}`);
	}

	// Framework (first language with a framework)
	const withFramework = signals.languages.find((l) => l.framework);
	if (withFramework?.framework) {
		lines.push(`- **Framework:** ${withFramework.framework}`);
	}

	// Test framework + file pattern
	const { testConventions } = signals;
	if (testConventions.framework) {
		lines.push(
			`- **Test framework:** ${testConventions.framework} (\`${testConventions.filePattern}\`)`,
		);
	}

	// Source roots
	if (signals.directoryProfile.sourceRoots.length > 0) {
		lines.push(`- **Source roots:** ${signals.directoryProfile.sourceRoots.join(", ")}`);
	}

	// Top 5 import hotspots
	const topHotspots = signals.importHotspots.slice(0, 5);
	if (topHotspots.length > 0) {
		lines.push(`- **Top imports:** ${topHotspots.map((h) => h.module).join(", ")}`);
	}

	// Shared invariants summary
	if (signals.sharedInvariants.length > 0) {
		const types = [...new Set(signals.sharedInvariants.map((i) => i.type))].join(", ");
		lines.push(`- **Invariants:** ${types}`);
	}

	return lines.join("\n");
}

function renderFull(context: ProjectContext): string {
	const { signals } = context;
	const lines: string[] = [
		"## Project Context",
		"",
		`_Generated: ${context.generatedAt} | Hash: ${context.structuralHash.slice(0, 8)}_`,
		"",
	];

	// Languages
	lines.push("### Languages", "");
	for (const lang of signals.languages) {
		let line = `- **${lang.language}**`;
		if (lang.framework) line += ` / ${lang.framework}`;
		if (lang.packageManager) line += ` (${lang.packageManager})`;
		line += ` — \`${lang.configFile}\``;
		lines.push(line);
	}
	if (signals.languages.length === 0) lines.push("_none detected_");
	lines.push("");

	// Directory profile
	lines.push("### Directory Profile", "");
	if (signals.directoryProfile.sourceRoots.length > 0) {
		lines.push(`- **Source roots:** ${signals.directoryProfile.sourceRoots.join(", ")}`);
	}
	if (signals.directoryProfile.testRoots.length > 0) {
		lines.push(`- **Test roots:** ${signals.directoryProfile.testRoots.join(", ")}`);
	}
	for (const zone of signals.directoryProfile.zones) {
		lines.push(`- \`${zone.path}\` — ${zone.category}`);
	}
	if (
		signals.directoryProfile.sourceRoots.length === 0 &&
		signals.directoryProfile.testRoots.length === 0 &&
		signals.directoryProfile.zones.length === 0
	) {
		lines.push("_none detected_");
	}
	lines.push("");

	// Naming vocabulary
	lines.push("### Naming Vocabulary", "");
	if (signals.namingVocabulary.commonPrefixes.length > 0) {
		lines.push(`- **Common prefixes:** ${signals.namingVocabulary.commonPrefixes.join(", ")}`);
	}
	for (const conv of signals.namingVocabulary.conventions) {
		lines.push(`- \`${conv.pattern}\` — ${conv.description}`);
	}
	if (
		signals.namingVocabulary.commonPrefixes.length === 0 &&
		signals.namingVocabulary.conventions.length === 0
	) {
		lines.push("_none detected_");
	}
	lines.push("");

	// Test conventions
	lines.push("### Test Conventions", "");
	const { testConventions } = signals;
	if (testConventions.framework) lines.push(`- **Framework:** ${testConventions.framework}`);
	if (testConventions.filePattern)
		lines.push(`- **File pattern:** \`${testConventions.filePattern}\``);
	if (testConventions.testRoots.length > 0) {
		lines.push(`- **Test roots:** ${testConventions.testRoots.join(", ")}`);
	}
	if (testConventions.setupFiles.length > 0) {
		lines.push(`- **Setup files:** ${testConventions.setupFiles.join(", ")}`);
	}
	if (!testConventions.framework && !testConventions.filePattern) lines.push("_none detected_");
	lines.push("");

	// Error patterns
	lines.push("### Error Patterns", "");
	const { errorPatterns } = signals;
	if (errorPatterns.baseClass) lines.push(`- **Base class:** ${errorPatterns.baseClass}`);
	lines.push(`- **Throw style:** ${errorPatterns.throwStyle}`);
	for (const p of errorPatterns.patterns) {
		lines.push(`- \`${p}\``);
	}
	lines.push("");

	// Import hotspots
	lines.push("### Import Hotspots", "");
	for (const h of signals.importHotspots) {
		lines.push(`- \`${h.module}\` — ${h.importCount} imports`);
	}
	if (signals.importHotspots.length === 0) lines.push("_none detected_");
	lines.push("");

	// Config zones
	lines.push("### Config Zones", "");
	for (const zone of signals.configZones) {
		lines.push(`- \`${zone.path}\` — ${zone.category}`);
	}
	if (signals.configZones.length === 0) lines.push("_none detected_");
	lines.push("");

	// Shared invariants
	lines.push("### Shared Invariants", "");
	for (const inv of signals.sharedInvariants) {
		lines.push(`- **${inv.type}:** ${inv.description} (\`${inv.source}\`)`);
	}
	if (signals.sharedInvariants.length === 0) lines.push("_none detected_");

	return lines.join("\n");
}
