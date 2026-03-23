import type { CompatibilityResult, SurfaceChange } from "./types.ts";

function escapeCell(s: string): string {
	return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatRow(c: SurfaceChange): string {
	const name = escapeCell(c.symbol.name);
	const file = escapeCell(c.symbol.filePath);
	const kind = c.kind;
	const severity = c.severity;
	const oldSig = escapeCell(c.previousSignature ?? "—");
	const newSig = c.kind === "removed" ? "—" : escapeCell(c.symbol.signature);
	return `| ${name} | ${file} | ${kind} | ${severity} | ${oldSig} | ${newSig} |`;
}

export function formatCompatReport(result: CompatibilityResult): string {
	const verdict = result.compatible ? "Compatible" : "Incompatible";
	const lines: string[] = [
		"# Compatibility Report",
		"",
		`**Branch A:** ${result.branchA}  `,
		`**Branch B:** ${result.branchB}  `,
		`**Analyzed at:** ${result.analyzedAt}  `,
		`**Verdict:** ${verdict}`,
		"",
	];

	if (result.changes.length > 0) {
		lines.push(
			"| Symbol | File | Kind | Severity | Old Signature | New Signature |",
			"| --- | --- | --- | --- | --- | --- |",
		);
		for (const c of result.changes) {
			lines.push(formatRow(c));
		}
		lines.push("");
	}

	lines.push("## Summary", "", result.summary, "");

	if (!result.staticOnly) {
		lines.push("> **Note:** AI analysis was used to enrich the summary above.", "");
	}

	return lines.join("\n");
}
