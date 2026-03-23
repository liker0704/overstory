import { KNOWN_FIELDS } from "./config-schema.ts";
import { ValidationError } from "./errors.ts";

/** Returns true when val is a plain object (not null, not array). */
function isObj(val: unknown): val is Record<string, unknown> {
	return val !== null && val !== undefined && typeof val === "object" && !Array.isArray(val);
}

/**
 * Assert that every key in `obj` is a member of `allowed`.
 * Throws a ValidationError with a precise, actionable message on the first unknown key found.
 */
function assertKnownKeys(
	obj: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
): void {
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) {
			throw new ValidationError(
				`Unknown field '${path}.${key}'. Check for typos or see the config reference.`,
				{ field: `${path}.${key}`, value: undefined },
			);
		}
	}
}

/**
 * Validate a raw parsed config object (or partial override) for unknown fields.
 *
 * Call this on the raw YAML object **before** merging with defaults, so that
 * only user-provided keys are checked (not defaults injected by the loader).
 *
 * Sections with dynamic keys (providers, models, runtime.capabilities, runtime.pi.modelMap)
 * are not checked at the key level; their value shapes are validated by validateConfigValues.
 *
 * Throws ValidationError with a precise path on the first unknown field encountered.
 */
export function validateUnknownFields(raw: Record<string, unknown>): void {
	assertKnownKeys(raw, KNOWN_FIELDS.root, "config");

	if (isObj(raw.project)) {
		assertKnownKeys(raw.project, KNOWN_FIELDS.project, "project");
		const qg = raw.project.qualityGates;
		if (Array.isArray(qg)) {
			for (let i = 0; i < qg.length; i++) {
				const item = qg[i];
				if (isObj(item)) {
					assertKnownKeys(item, KNOWN_FIELDS.qualityGateItem, `project.qualityGates[${i}]`);
				}
			}
		}
	}

	if (isObj(raw.agents)) {
		assertKnownKeys(raw.agents, KNOWN_FIELDS.agents, "agents");
	}

	if (isObj(raw.worktrees)) {
		assertKnownKeys(raw.worktrees, KNOWN_FIELDS.worktrees, "worktrees");
	}

	if (isObj(raw.taskTracker)) {
		assertKnownKeys(raw.taskTracker, KNOWN_FIELDS.taskTracker, "taskTracker");
		if (isObj(raw.taskTracker.github)) {
			assertKnownKeys(raw.taskTracker.github, KNOWN_FIELDS.taskTrackerGithub, "taskTracker.github");
		}
	}

	if (isObj(raw.mulch)) {
		assertKnownKeys(raw.mulch, KNOWN_FIELDS.mulch, "mulch");
	}

	if (isObj(raw.merge)) {
		assertKnownKeys(raw.merge, KNOWN_FIELDS.merge, "merge");
	}

	if (isObj(raw.watchdog)) {
		assertKnownKeys(raw.watchdog, KNOWN_FIELDS.watchdog, "watchdog");
	}

	if (isObj(raw.logging)) {
		assertKnownKeys(raw.logging, KNOWN_FIELDS.logging, "logging");
	}

	if (isObj(raw.coordinator)) {
		assertKnownKeys(raw.coordinator, KNOWN_FIELDS.coordinator, "coordinator");
		if (isObj(raw.coordinator.exitTriggers)) {
			assertKnownKeys(
				raw.coordinator.exitTriggers,
				KNOWN_FIELDS.coordinatorExitTriggers,
				"coordinator.exitTriggers",
			);
		}
	}

	if (isObj(raw.rateLimit)) {
		assertKnownKeys(raw.rateLimit, KNOWN_FIELDS.rateLimit, "rateLimit");
	}

	if (isObj(raw.mission)) {
		assertKnownKeys(raw.mission, KNOWN_FIELDS.mission, "mission");
		if (isObj(raw.mission.planReview)) {
			assertKnownKeys(raw.mission.planReview, KNOWN_FIELDS.missionPlanReview, "mission.planReview");
		}
	}

	if (isObj(raw.mail)) {
		assertKnownKeys(raw.mail, KNOWN_FIELDS.mail, "mail");
		if (isObj(raw.mail.reliability)) {
			assertKnownKeys(raw.mail.reliability, KNOWN_FIELDS.mailReliability, "mail.reliability");
		}
	}

	if (isObj(raw.resilience)) {
		assertKnownKeys(raw.resilience, KNOWN_FIELDS.resilience, "resilience");
		if (isObj(raw.resilience.retry)) {
			assertKnownKeys(raw.resilience.retry, KNOWN_FIELDS.resilienceRetry, "resilience.retry");
		}
		if (isObj(raw.resilience.circuitBreaker)) {
			assertKnownKeys(
				raw.resilience.circuitBreaker,
				KNOWN_FIELDS.resilienceCircuitBreaker,
				"resilience.circuitBreaker",
			);
		}
		if (isObj(raw.resilience.reroute)) {
			assertKnownKeys(raw.resilience.reroute, KNOWN_FIELDS.resilienceReroute, "resilience.reroute");
		}
	}

	if (isObj(raw.headroom)) {
		assertKnownKeys(raw.headroom, KNOWN_FIELDS.headroom, "headroom");
		if (isObj(raw.headroom.throttle)) {
			assertKnownKeys(raw.headroom.throttle, KNOWN_FIELDS.headroomThrottle, "headroom.throttle");
		}
	}

	if (isObj(raw.reminders)) {
		assertKnownKeys(raw.reminders, KNOWN_FIELDS.reminders, "reminders");
	}

	if (isObj(raw.runtime)) {
		assertKnownKeys(raw.runtime, KNOWN_FIELDS.runtime, "runtime");
		if (isObj(raw.runtime.pi)) {
			assertKnownKeys(raw.runtime.pi, KNOWN_FIELDS.runtimePi, "runtime.pi");
		}
	}

	// providers: dynamic keys, but validate each provider object's shape
	if (isObj(raw.providers)) {
		for (const [name, provider] of Object.entries(raw.providers)) {
			if (isObj(provider)) {
				assertKnownKeys(provider, KNOWN_FIELDS.providerItem, `providers.${name}`);
			}
		}
	}

	// models: Record<string, ModelRef> — dynamic keys, scalar values, no nested check needed.
	// runtime.capabilities: Record<string, string> — dynamic keys, no nested check needed.
}
