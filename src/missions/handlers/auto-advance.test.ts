import { describe, expect, test } from "bun:test";
import { autoAdvanceHandlers } from "./auto-advance.ts";

describe("autoAdvanceHandlers", () => {
	test("align-auto-advance returns phase_advance trigger", async () => {
		const handler = autoAdvanceHandlers["align-auto-advance"];
		expect(handler).toBeDefined();
		const result = await handler!({} as never);
		expect(result.trigger).toBe("phase_advance");
	});

	test("decide-auto-advance returns phase_advance trigger", async () => {
		const handler = autoAdvanceHandlers["decide-auto-advance"];
		expect(handler).toBeDefined();
		const result = await handler!({} as never);
		expect(result.trigger).toBe("phase_advance");
	});
});
