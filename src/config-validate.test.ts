import { describe, expect, test } from "bun:test";
import { validateUnknownFields } from "./config-validate.ts";
import { ValidationError } from "./errors.ts";

function expectUnknown(raw: Record<string, unknown>): void {
	expect(() => validateUnknownFields(raw)).toThrow(ValidationError);
}

function expectValid(raw: Record<string, unknown>): void {
	expect(() => validateUnknownFields(raw)).not.toThrow();
}

describe("validateUnknownFields - root level", () => {
	test("accepts all known top-level keys", () => {
		expectValid({
			version: 2,
			project: {},
			agents: {},
			worktrees: {},
			taskTracker: {},
			mulch: {},
			merge: {},
			providers: {},
			watchdog: {},
			models: {},
			logging: {},
			coordinator: {},
			rateLimit: {},
			runtime: {},
		});
	});

	test("rejects unknown top-level key", () => {
		expectUnknown({ watchodg: {} });
		expectUnknown({ claud: {} });
		expectUnknown({ runtimeConfig: {} });
	});

	test("error message includes the bad key and path", () => {
		const err = (() => {
			try {
				validateUnknownFields({ watchodg: {} });
			} catch (e) {
				return e;
			}
		})();
		expect(err).toBeInstanceOf(ValidationError);
		expect((err as ValidationError).message).toContain("watchodg");
		expect((err as ValidationError).message).toContain("config");
	});

	test("accepts empty object", () => {
		expectValid({});
	});

	test("accepts version field", () => {
		expectValid({ version: 1 });
		expectValid({ version: 2 });
	});
});

describe("validateUnknownFields - project section", () => {
	test("rejects unknown field under project", () => {
		expectUnknown({ project: { canonicalBranch: "main", canonical: "main" } });
	});

	test("accepts all known project fields", () => {
		expectValid({
			project: {
				name: "my-project",
				root: "/path/to/root",
				canonicalBranch: "main",
				qualityGates: [],
			},
		});
	});

	test("accepts partial project section", () => {
		expectValid({ project: { canonicalBranch: "main" } });
	});

	test("rejects unknown field in qualityGates item", () => {
		expectUnknown({
			project: {
				qualityGates: [{ name: "Test", command: "bun test", description: "pass", extra: true }],
			},
		});
	});

	test("accepts valid qualityGates items", () => {
		expectValid({
			project: {
				qualityGates: [
					{ name: "Test", command: "bun test", description: "all pass" },
					{ name: "Lint", command: "bun run lint", description: "no errors" },
				],
			},
		});
	});
});

describe("validateUnknownFields - agents section", () => {
	test("rejects unknown field under agents", () => {
		expectUnknown({ agents: { maxConcurent: 10 } }); // typo
	});

	test("accepts all known agent fields", () => {
		expectValid({
			agents: {
				manifestPath: ".overstory/agent-manifest.json",
				baseDir: ".overstory/agent-defs",
				maxConcurrent: 10,
				staggerDelayMs: 2000,
				maxDepth: 2,
				maxSessionsPerRun: 0,
				maxAgentsPerLead: 5,
			},
		});
	});
});

describe("validateUnknownFields - watchdog section", () => {
	test("rejects unknown field under watchdog", () => {
		expectUnknown({ watchdog: { tier0Enabled: true, unknownKey: true } });
	});

	test("accepts all known watchdog fields", () => {
		expectValid({
			watchdog: {
				tier0Enabled: true,
				tier0IntervalMs: 30000,
				tier1Enabled: false,
				tier2Enabled: false,
				staleThresholdMs: 300000,
				zombieThresholdMs: 600000,
				nudgeIntervalMs: 60000,
			},
		});
	});
});

describe("validateUnknownFields - coordinator section", () => {
	test("rejects unknown field under coordinator", () => {
		expectUnknown({ coordinator: { autoPul: true } }); // typo
	});

	test("rejects unknown field in coordinator.exitTriggers", () => {
		expectUnknown({
			coordinator: {
				exitTriggers: { allAgentsDone: true, onComplete: true },
			},
		});
	});

	test("accepts all known coordinator fields", () => {
		expectValid({
			coordinator: {
				autoPull: true,
				exitTriggers: {
					allAgentsDone: true,
					taskTrackerEmpty: false,
					onShutdownSignal: false,
				},
			},
		});
	});
});

describe("validateUnknownFields - taskTracker section", () => {
	test("rejects unknown field under taskTracker", () => {
		expectUnknown({ taskTracker: { backend: "auto", enable: true } }); // typo for enabled
	});

	test("rejects unknown field under taskTracker.github", () => {
		expectUnknown({
			taskTracker: {
				backend: "github",
				enabled: true,
				github: { pollIntervalMs: 30000, extraKey: true },
			},
		});
	});

	test("accepts all known taskTracker.github fields", () => {
		expectValid({
			taskTracker: {
				backend: "github",
				enabled: true,
				github: {
					pollIntervalMs: 30000,
					owner: "my-org",
					repo: "my-repo",
					readyLabel: "ov-ready",
					activeLabel: "ov-active",
					maxConcurrent: 5,
				},
			},
		});
	});
});

describe("validateUnknownFields - runtime section", () => {
	test("rejects unknown field under runtime", () => {
		expectUnknown({ runtime: { default: "claude", shellInitDelay: 500 } }); // wrong key
	});

	test("rejects unknown field under runtime.pi", () => {
		expectUnknown({
			runtime: {
				pi: { provider: "anthropic", modelMap: {}, extraPiField: true },
			},
		});
	});

	test("accepts all known runtime fields", () => {
		expectValid({
			runtime: {
				default: "claude",
				capabilities: { builder: "pi" },
				printCommand: "print",
				pi: {
					provider: "anthropic",
					modelMap: { sonnet: "anthropic/claude-sonnet-4-6" },
				},
				shellInitDelayMs: 0,
			},
		});
	});
});

describe("validateUnknownFields - providers section", () => {
	test("rejects unknown field in a provider object", () => {
		expectUnknown({
			providers: {
				openrouter: { type: "gateway", baseUrl: "https://x.com", authTokenEnv: "KEY", extra: 1 },
			},
		});
	});

	test("accepts valid provider objects", () => {
		expectValid({
			providers: {
				anthropic: { type: "native" },
				openrouter: {
					type: "gateway",
					baseUrl: "https://openrouter.ai/api/v1",
					authTokenEnv: "OPENROUTER_API_KEY",
				},
			},
		});
	});

	test("allows arbitrary provider names (dynamic keys)", () => {
		expectValid({
			providers: {
				"my-custom-provider": { type: "native" },
				litellm: { type: "gateway", baseUrl: "http://localhost:4000", authTokenEnv: "KEY" },
			},
		});
	});
});

describe("validateUnknownFields - models section", () => {
	test("allows arbitrary model role keys (dynamic keys)", () => {
		expectValid({
			models: {
				coordinator: "sonnet",
				builder: "opus",
				"custom-role": "haiku",
			},
		});
	});
});

describe("validateUnknownFields - reminders section", () => {
	test("rejects unknown field under reminders", () => {
		expectUnknown({ reminders: { lookbackWindowMs: 86400000, unknownField: true } });
	});

	test("accepts all known reminders fields", () => {
		expectValid({
			reminders: {
				lookbackWindowMs: 86400000,
				completionTrendThreshold: 0.15,
				mergeConflictThreshold: 0.25,
				errorRecurrenceMinCount: 3,
				staleEscalationMaxAgeMs: 14400000,
				escalationResponseMinRate: 0.5,
			},
		});
	});

	test("accepts partial reminders section", () => {
		expectValid({ reminders: { lookbackWindowMs: 3600000 } });
	});

	test("accepts empty reminders section", () => {
		expectValid({ reminders: {} });
	});
});
