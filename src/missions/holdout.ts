import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionStore } from "../sessions/store.ts";
import type { HoldoutCheck, HoldoutCheckStatus, HoldoutLevel, HoldoutResult } from "../types.ts";
import { createMissionStore } from "./store.ts";

// === DI Interface ===

export interface HoldoutDeps {
	runCommand?: (
		cmd: string[],
		cwd: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

// === Default subprocess runner ===

async function defaultRunCommand(
	cmd: string[],
	cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr };
}

// === Helpers ===

function makeCheck(
	id: string,
	level: HoldoutLevel,
	name: string,
	status: HoldoutCheckStatus,
	message: string,
	details?: string[],
): HoldoutCheck {
	return { id, level, name, status, message, details };
}

function checkSections(content: string, required: string[]): string[] {
	const missing: string[] = [];
	for (const section of required) {
		if (!content.includes(section)) {
			missing.push(section);
		}
	}
	return missing;
}

// === Level 1 Checks ===

/**
 * Run quality gates from project config instead of hardcoded bun commands.
 * Falls back to DEFAULT_QUALITY_GATES if config has no gates defined.
 */
async function checkQualityGates(
	projectRoot: string,
	qualityGates: ReadonlyArray<{ name: string; command: string; description?: string }>,
	run: (
		cmd: string[],
		cwd: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<HoldoutCheck[]> {
	const checks: HoldoutCheck[] = [];
	for (const gate of qualityGates) {
		const cmd = gate.command.split(" ");
		const result = await run(cmd, projectRoot);
		const id = `l1-${gate.name.toLowerCase().replace(/\s+/g, "-")}`;
		if (result.exitCode === 0) {
			checks.push(makeCheck(id, 1, gate.name, "pass", `${gate.command} passed`));
		} else {
			const output = (result.stderr || result.stdout).split("\n").slice(0, 5);
			checks.push(makeCheck(id, 1, gate.name, "fail", `${gate.command} failed`, output));
		}
	}
	return checks;
}

function checkL1ArchitectureStructure(artifactRoot: string): HoldoutCheck {
	const archPath = join(artifactRoot, "architecture.md");
	if (!existsSync(archPath)) {
		return makeCheck(
			"l1-architecture-structure",
			1,
			"Architecture Structure",
			"skip",
			"No architecture.md found in artifact root",
		);
	}
	const content = readFileSync(archPath, "utf8");
	const required = ["## Components", "## Interfaces", "## Constraints"];
	const missing = checkSections(content, required);
	if (missing.length === 0) {
		return makeCheck(
			"l1-architecture-structure",
			1,
			"Architecture Structure",
			"pass",
			"architecture.md contains all required sections",
		);
	}
	return makeCheck(
		"l1-architecture-structure",
		1,
		"Architecture Structure",
		"fail",
		"architecture.md missing required sections",
		missing,
	);
}

function checkL1TestPlanStructure(artifactRoot: string): HoldoutCheck {
	const planPath = join(artifactRoot, "test-plan.yaml");
	if (!existsSync(planPath)) {
		return makeCheck(
			"l1-test-plan-structure",
			1,
			"Test Plan Structure",
			"skip",
			"No test-plan.yaml found in artifact root",
		);
	}
	const content = readFileSync(planPath, "utf8");
	const requiredFields = ["version:", "missionId:", "suites:"];
	const missing = requiredFields.filter((f) => !content.includes(f));
	if (missing.length === 0) {
		return makeCheck(
			"l1-test-plan-structure",
			1,
			"Test Plan Structure",
			"pass",
			"test-plan.yaml contains required fields",
		);
	}
	return makeCheck(
		"l1-test-plan-structure",
		1,
		"Test Plan Structure",
		"fail",
		"test-plan.yaml missing required fields",
		missing,
	);
}

async function checkL1TestIntegrity(
	projectRoot: string,
	sessionDbPath: string,
	run: (
		cmd: string[],
		cwd: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<HoldoutCheck> {
	// Check if a tester was spawned
	const sessionStore = createSessionStore(sessionDbPath);
	const sessions = sessionStore.getAll();
	sessionStore.close();

	const testerSession = sessions.find((s) => s.capability === "tester");
	if (!testerSession) {
		return makeCheck(
			"l1-test-integrity",
			1,
			"Test Integrity",
			"skip",
			"No tester agent was spawned — skipping test integrity check",
		);
	}

	// Find test files authored by the tester
	const testerBranch = testerSession.branchName;
	const testerResult = await run(
		["git", "log", "--name-only", "--format=", testerBranch, "--diff-filter=A", "--", "*.test.ts"],
		projectRoot,
	);
	if (testerResult.exitCode !== 0) {
		return makeCheck(
			"l1-test-integrity",
			1,
			"Test Integrity",
			"warn",
			"Could not inspect tester git log",
			[testerResult.stderr],
		);
	}
	const testerTestFiles = new Set(
		testerResult.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0),
	);
	if (testerTestFiles.size === 0) {
		return makeCheck(
			"l1-test-integrity",
			1,
			"Test Integrity",
			"pass",
			"No test files authored by tester — nothing to verify",
		);
	}

	// Check if any builder modified the tester's test files
	const builderSessions = sessions.filter((s) => s.capability === "builder" && s.branchName);
	const violations: string[] = [];
	for (const builder of builderSessions) {
		const builderResult = await run(
			["git", "log", "--name-only", "--format=", builder.branchName, "--", "*.test.ts"],
			projectRoot,
		);
		if (builderResult.exitCode !== 0) continue;
		const builderFiles = builderResult.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);
		for (const file of builderFiles) {
			if (testerTestFiles.has(file)) {
				violations.push(`${builder.agentName} modified tester file: ${file}`);
			}
		}
	}

	if (violations.length > 0) {
		return makeCheck(
			"l1-test-integrity",
			1,
			"Test Integrity",
			"fail",
			`${violations.length} builder(s) modified tester-authored test files`,
			violations,
		);
	}
	return makeCheck(
		"l1-test-integrity",
		1,
		"Test Integrity",
		"pass",
		"No builders modified tester-authored test files",
	);
}

async function checkL1TestPlanCoverage(
	artifactRoot: string,
	projectRoot: string,
	run: (
		cmd: string[],
		cwd: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<HoldoutCheck> {
	const planPath = join(artifactRoot, "test-plan.yaml");
	if (!existsSync(planPath)) {
		return makeCheck(
			"l1-test-plan-coverage",
			1,
			"Test Plan Coverage",
			"skip",
			"No test-plan.yaml found — skipping coverage check",
		);
	}
	const content = readFileSync(planPath, "utf8");
	// Extract case IDs: lines matching "  - id: <value>"
	const caseIdMatches = content.matchAll(/^\s*-\s+id:\s+(\S+)/gm);
	const caseIds = Array.from(caseIdMatches, (m) => m[1] ?? "").filter(Boolean);

	if (caseIds.length === 0) {
		return makeCheck(
			"l1-test-plan-coverage",
			1,
			"Test Plan Coverage",
			"skip",
			"No case IDs found in test-plan.yaml",
		);
	}

	const missing: string[] = [];
	for (const caseId of caseIds) {
		const result = await run(["grep", "-r", "--include=*.test.ts", caseId, "."], projectRoot);
		if (result.exitCode !== 0) {
			missing.push(caseId);
		}
	}

	if (missing.length === 0) {
		return makeCheck(
			"l1-test-plan-coverage",
			1,
			"Test Plan Coverage",
			"pass",
			`All ${caseIds.length} case IDs found in test files`,
		);
	}
	return makeCheck(
		"l1-test-plan-coverage",
		1,
		"Test Plan Coverage",
		"warn",
		`${missing.length} of ${caseIds.length} case IDs not found in test files`,
		missing,
	);
}

// === Level 2 Checks ===

async function checkL2ComponentsExist(
	artifactRoot: string,
	projectRoot: string,
	run: (
		cmd: string[],
		cwd: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<HoldoutCheck> {
	const archPath = join(artifactRoot, "architecture.md");
	if (!existsSync(archPath)) {
		return makeCheck(
			"l2-components-exist",
			2,
			"Components Exist",
			"skip",
			"No architecture.md found — skipping component existence check",
		);
	}
	const content = readFileSync(archPath, "utf8");

	// Parse Components section for CREATE/MODIFY entries
	const componentsMatch = content.match(/## Components\n([\s\S]*?)(?=\n## |$)/);
	if (!componentsMatch) {
		return makeCheck(
			"l2-components-exist",
			2,
			"Components Exist",
			"skip",
			"No Components section found",
		);
	}

	const componentsBody = componentsMatch[1] ?? "";
	const createEntries = Array.from(
		componentsBody.matchAll(/CREATE\s+(\S+)/g),
		(m) => m[1] ?? "",
	).filter(Boolean);
	const modifyEntries = Array.from(
		componentsBody.matchAll(/MODIFY\s+(\S+)/g),
		(m) => m[1] ?? "",
	).filter(Boolean);

	const missing: string[] = [];
	for (const filePath of createEntries) {
		if (!existsSync(join(projectRoot, filePath))) {
			missing.push(`CREATE ${filePath} (file not found)`);
		}
	}

	for (const filePath of modifyEntries) {
		const result = await run(["git", "diff", "--name-only", "HEAD~1", "--", filePath], projectRoot);
		if (result.exitCode !== 0 || result.stdout.trim() === "") {
			missing.push(`MODIFY ${filePath} (no changes in git diff)`);
		}
	}

	if (missing.length === 0) {
		return makeCheck(
			"l2-components-exist",
			2,
			"Components Exist",
			"pass",
			`All ${createEntries.length + modifyEntries.length} components verified`,
		);
	}
	return makeCheck(
		"l2-components-exist",
		2,
		"Components Exist",
		"fail",
		`${missing.length} component(s) not verified`,
		missing,
	);
}

async function checkL2InterfaceExports(
	artifactRoot: string,
	projectRoot: string,
	run: (
		cmd: string[],
		cwd: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<HoldoutCheck> {
	const archPath = join(artifactRoot, "architecture.md");
	if (!existsSync(archPath)) {
		return makeCheck(
			"l2-interface-exports",
			2,
			"Interface Exports",
			"skip",
			"No architecture.md found — skipping interface export check",
		);
	}
	const content = readFileSync(archPath, "utf8");
	const interfacesMatch = content.match(/## Interfaces\n([\s\S]*?)(?=\n## |$)/);
	if (!interfacesMatch) {
		return makeCheck(
			"l2-interface-exports",
			2,
			"Interface Exports",
			"skip",
			"No Interfaces section found",
		);
	}

	const interfacesBody = interfacesMatch[1] ?? "";
	// Extract export names from backtick-quoted identifiers
	const exportNames = Array.from(interfacesBody.matchAll(/`(\w+)`/g), (m) => m[1] ?? "").filter(
		Boolean,
	);

	if (exportNames.length === 0) {
		return makeCheck(
			"l2-interface-exports",
			2,
			"Interface Exports",
			"skip",
			"No interface exports found in spec",
		);
	}

	const missing: string[] = [];
	for (const name of exportNames) {
		const result = await run(
			["grep", "-r", "--include=*.ts", `export.*${name}`, "src"],
			projectRoot,
		);
		if (result.exitCode !== 0) {
			missing.push(name);
		}
	}

	if (missing.length === 0) {
		return makeCheck(
			"l2-interface-exports",
			2,
			"Interface Exports",
			"pass",
			`All ${exportNames.length} interface exports found`,
		);
	}
	return makeCheck(
		"l2-interface-exports",
		2,
		"Interface Exports",
		"fail",
		`${missing.length} of ${exportNames.length} exports not found`,
		missing,
	);
}

function checkL2TddCompliance(sessionDbPath: string, artifactRoot: string): HoldoutCheck {
	// Primary: check workstreams.json for TDD mode (canonical source)
	const wsPath = join(artifactRoot, "plan", "workstreams.json");
	let hasTddFull = false;
	if (existsSync(wsPath)) {
		try {
			const content = readFileSync(wsPath, "utf8");
			const parsed = JSON.parse(content) as { workstreams?: Array<{ tddMode?: string }> };
			hasTddFull = parsed.workstreams?.some((ws) => ws.tddMode === "full") ?? false;
		} catch {
			// Fallback to architecture.md scan below
		}
	}
	// Fallback: scan architecture.md for TDD indicators
	if (!hasTddFull) {
		const archPath = join(artifactRoot, "architecture.md");
		if (existsSync(archPath)) {
			const archContent = readFileSync(archPath, "utf8");
			hasTddFull = archContent.includes("tddMode: full") || archContent.includes("TDD Mode: Full");
		}
	}
	if (!hasTddFull) {
		return makeCheck(
			"l2-tdd-compliance",
			2,
			"TDD Compliance",
			"skip",
			"Mission did not use full TDD mode",
		);
	}

	const sessionStore = createSessionStore(sessionDbPath);
	const sessions = sessionStore.getAll();
	sessionStore.close();

	const testerSpawned = sessions.some((s) => s.capability === "tester");
	if (testerSpawned) {
		return makeCheck(
			"l2-tdd-compliance",
			2,
			"TDD Compliance",
			"pass",
			"Tester agent was spawned for full TDD mission",
		);
	}
	return makeCheck(
		"l2-tdd-compliance",
		2,
		"TDD Compliance",
		"fail",
		"Full TDD mode requires a tester agent but none was spawned",
	);
}

async function checkL2ProhibitionCompliance(
	artifactRoot: string,
	projectRoot: string,
	run: (
		cmd: string[],
		cwd: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<HoldoutCheck> {
	const archPath = join(artifactRoot, "architecture.md");
	if (!existsSync(archPath)) {
		return makeCheck(
			"l2-prohibition-compliance",
			2,
			"Prohibition Compliance",
			"skip",
			"No architecture.md found — skipping prohibition check",
		);
	}
	const content = readFileSync(archPath, "utf8");
	const constraintsMatch = content.match(/## Constraints\n([\s\S]*?)(?=\n## |$)/);
	if (!constraintsMatch) {
		return makeCheck(
			"l2-prohibition-compliance",
			2,
			"Prohibition Compliance",
			"skip",
			"No Constraints section found",
		);
	}

	const constraintsBody = constraintsMatch[1] ?? "";
	const prohibitionsMatch = constraintsBody.match(/prohibitions[:\s]*([\s\S]*?)(?=\n\w|$)/i);
	if (!prohibitionsMatch) {
		return makeCheck(
			"l2-prohibition-compliance",
			2,
			"Prohibition Compliance",
			"skip",
			"No prohibitions found in Constraints section",
		);
	}

	const prohibitionsBody = prohibitionsMatch[1] ?? "";
	const patterns = prohibitionsBody
		.split("\n")
		.map((l) => l.replace(/^[-*\s]+/, "").trim())
		.filter((l) => l.length > 0);

	if (patterns.length === 0) {
		return makeCheck(
			"l2-prohibition-compliance",
			2,
			"Prohibition Compliance",
			"skip",
			"No prohibition patterns found",
		);
	}

	const violations: string[] = [];
	for (const pattern of patterns) {
		const result = await run(["grep", "-r", "--include=*.ts", "-l", pattern, "src"], projectRoot);
		if (result.exitCode === 0 && result.stdout.trim() !== "") {
			violations.push(`Pattern "${pattern}" found in: ${result.stdout.trim()}`);
		}
	}

	if (violations.length === 0) {
		return makeCheck(
			"l2-prohibition-compliance",
			2,
			"Prohibition Compliance",
			"pass",
			`All ${patterns.length} prohibition patterns are absent`,
		);
	}
	return makeCheck(
		"l2-prohibition-compliance",
		2,
		"Prohibition Compliance",
		"fail",
		`${violations.length} prohibition violation(s) found`,
		violations,
	);
}

async function checkL2FileScopeCompliance(
	projectRoot: string,
	sessionDbPath: string,
	run: (
		cmd: string[],
		cwd: string,
	) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): Promise<HoldoutCheck> {
	const sessionStore = createSessionStore(sessionDbPath);
	const sessions = sessionStore.getAll();
	sessionStore.close();

	const builders = sessions.filter((s) => s.capability === "builder");
	if (builders.length === 0) {
		return makeCheck(
			"l2-file-scope-compliance",
			2,
			"File Scope Compliance",
			"skip",
			"No builder agents found in sessions",
		);
	}

	const violations: string[] = [];
	for (const builder of builders) {
		const branch = builder.branchName;
		const result = await run(
			["git", "log", "--name-only", "--format=", branch, "--not", "main"],
			projectRoot,
		);
		if (result.exitCode !== 0) continue;

		// We can only do basic checking here without fileScope info in sessions
		// Check that touched files are within src/ (basic sanity)
		const touchedFiles = result.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0);

		const outOfScope = touchedFiles.filter(
			(f) => !f.startsWith("src/") && !f.startsWith(".claude/") && f !== "package.json",
		);
		if (outOfScope.length > 0) {
			violations.push(
				`${builder.agentName}: files outside expected scope: ${outOfScope.join(", ")}`,
			);
		}
	}

	if (violations.length === 0) {
		return makeCheck(
			"l2-file-scope-compliance",
			2,
			"File Scope Compliance",
			"pass",
			`All ${builders.length} builder(s) stayed within file scope`,
		);
	}
	return makeCheck(
		"l2-file-scope-compliance",
		2,
		"File Scope Compliance",
		"fail",
		`${violations.length} file scope violation(s) found`,
		violations,
	);
}

// === Level 3 Stub ===

function stubL3Checks(): HoldoutCheck[] {
	return [
		makeCheck(
			"l3-llm-advisory",
			3,
			"LLM Advisory",
			"skip",
			"Level 3 LLM checks not yet implemented",
		),
	];
}

// === Main Entry Point ===

export async function runMissionHoldout(
	opts: {
		overstoryDir: string;
		projectRoot: string;
		missionId: string;
		maxLevel?: HoldoutLevel;
	},
	_deps: HoldoutDeps = {},
): Promise<HoldoutResult> {
	const start = Date.now();
	const { overstoryDir, projectRoot, missionId, maxLevel = 2 } = opts;
	const run = _deps.runCommand ?? defaultRunCommand;

	const sessionDbPath = join(overstoryDir, "sessions.db");

	// Load mission for artifactRoot
	const missionDbPath = sessionDbPath; // missions live in sessions.db
	const missionStore = createMissionStore(missionDbPath);
	const mission = missionStore.getById(missionId);
	missionStore.close();

	const artifactRoot = mission?.artifactRoot ?? "";

	const checks: HoldoutCheck[] = [];

	// === Level 1 ===
	if (maxLevel >= 1) {
		// Use project-configured quality gates instead of hardcoded bun commands.
		// Falls back to DEFAULT_QUALITY_GATES if config has none.
		const { loadConfig, DEFAULT_QUALITY_GATES: defaultGates } = await import("../config.ts");
		const config = await loadConfig(projectRoot);
		const gates = config.project.qualityGates ?? defaultGates;
		checks.push(...(await checkQualityGates(projectRoot, gates, run)));
		if (artifactRoot) {
			checks.push(checkL1ArchitectureStructure(artifactRoot));
			checks.push(checkL1TestPlanStructure(artifactRoot));
			checks.push(await checkL1TestIntegrity(projectRoot, sessionDbPath, run));
			checks.push(await checkL1TestPlanCoverage(artifactRoot, projectRoot, run));
		}
	}

	// === Level 2 ===
	if (maxLevel >= 2) {
		if (artifactRoot) {
			checks.push(await checkL2ComponentsExist(artifactRoot, projectRoot, run));
			checks.push(await checkL2InterfaceExports(artifactRoot, projectRoot, run));
			checks.push(checkL2TddCompliance(sessionDbPath, artifactRoot));
			checks.push(await checkL2ProhibitionCompliance(artifactRoot, projectRoot, run));
		}
		checks.push(await checkL2FileScopeCompliance(projectRoot, sessionDbPath, run));
	}

	// === Level 3 ===
	if (maxLevel >= 3) {
		checks.push(...stubL3Checks());
	}

	const level1Passed = checks.filter((c) => c.level === 1).every((c) => c.status !== "fail");
	const level2Passed = checks.filter((c) => c.level === 2).every((c) => c.status !== "fail");
	const level3Passed = maxLevel >= 3 ? false : null;
	const passed = level1Passed && level2Passed;

	return {
		missionId,
		passed,
		checks,
		level1Passed,
		level2Passed,
		level3Passed,
		duration: Date.now() - start,
	};
}
