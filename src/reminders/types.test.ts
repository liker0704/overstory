import { describe, expect, it } from "bun:test";
import { DEFAULT_REMINDER_CONFIG } from "./types.ts";

describe("DEFAULT_REMINDER_CONFIG", () => {
	it("has correct default values", () => {
		expect(DEFAULT_REMINDER_CONFIG.lookbackWindowMs).toBe(86400000);
		expect(DEFAULT_REMINDER_CONFIG.completionTrendThreshold).toBe(0.15);
		expect(DEFAULT_REMINDER_CONFIG.mergeConflictThreshold).toBe(0.25);
		expect(DEFAULT_REMINDER_CONFIG.errorRecurrenceMinCount).toBe(3);
		expect(DEFAULT_REMINDER_CONFIG.staleEscalationMaxAgeMs).toBe(14400000);
		expect(DEFAULT_REMINDER_CONFIG.escalationResponseMinRate).toBe(0.5);
	});
});
