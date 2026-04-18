import { describe, expect, test } from "bun:test";
import type { HandlerContext } from "../types.ts";
import { executeDirectPhaseCell } from "./execute-direct-phase.ts";
import type { PhaseCellDeps } from "./types.ts";

function makeDeps(): PhaseCellDeps {
	return {
		mailSend: async () => {},
		checkpointStore: {} as unknown as PhaseCellDeps["checkpointStore"],
		missionStore: {} as unknown as PhaseCellDeps["missionStore"],
	};
}

function makeCtx(checkpoint: unknown = null): HandlerContext {
	return {
		nodeId: "execute-phase:merge-all",
		checkpoint,
		getMission: () => null,
	} as HandlerContext;
}

describe("execute-direct-phase merge-all handler", () => {
	const handlers = executeDirectPhaseCell.buildHandlers(makeDeps());

	test("allDone=true → trigger=all_merged", async () => {
		const result = await handlers["merge-all"](makeCtx({ allDone: true }));
		expect(result.trigger).toBe("all_merged");
	});

	test("morePending=true → trigger=more_leads", async () => {
		const result = await handlers["merge-all"](makeCtx({ morePending: true }));
		expect(result.trigger).toBe("more_leads");
	});

	test("no checkpoint signal → defaults to all_merged (prevents BUG-E loop)", async () => {
		const result = await handlers["merge-all"](makeCtx(null));
		expect(result.trigger).toBe("all_merged");
	});

	test("empty checkpoint object → defaults to all_merged", async () => {
		const result = await handlers["merge-all"](makeCtx({}));
		expect(result.trigger).toBe("all_merged");
	});
});
