import { describe, expect, test } from "bun:test";
import { BUILTIN_HANDLERS, createHandlerRegistry, noopHandler } from "./handlers.ts";
import type { HandlerContext, HandlerResult } from "./types.ts";

/** Minimal HandlerContext stub for testing pure handlers. */
function makeCtx(overrides?: Partial<HandlerContext>): HandlerContext {
	return {
		missionId: "test-mission",
		nodeId: "understand:active",
		checkpoint: null,
		saveCheckpoint: async () => {},
		sendMail: async () => {},
		getMission: () => null,
		...overrides,
	};
}

describe("noopHandler", () => {
	test("returns trigger: default", async () => {
		const result: HandlerResult = await noopHandler(makeCtx());
		expect(result.trigger).toBe("default");
	});

	test("does not mutate context", async () => {
		const ctx = makeCtx();
		await noopHandler(ctx);
		expect(ctx.missionId).toBe("test-mission");
	});
});

describe("BUILTIN_HANDLERS", () => {
	test("contains noop key", () => {
		expect(typeof BUILTIN_HANDLERS.noop).toBe("function");
	});

	test("noop entry is noopHandler", () => {
		expect(BUILTIN_HANDLERS.noop).toBe(noopHandler);
	});
});

describe("createHandlerRegistry", () => {
	test("returns builtins when no overrides", () => {
		const registry = createHandlerRegistry();
		expect(typeof registry.noop).toBe("function");
	});

	test("merges custom handlers alongside builtins", async () => {
		const custom = async (_ctx: HandlerContext): Promise<HandlerResult> => ({ trigger: "done" });
		const registry = createHandlerRegistry({ custom });
		expect(registry.noop).toBe(noopHandler);
		expect(registry.custom).toBe(custom);
	});

	test("overrides can shadow a builtin key", async () => {
		const replacement = async (_ctx: HandlerContext): Promise<HandlerResult> => ({
			trigger: "replaced",
		});
		const registry = createHandlerRegistry({ noop: replacement });
		expect(registry.noop).toBe(replacement);
	});

	test("does not mutate BUILTIN_HANDLERS", () => {
		createHandlerRegistry({ noop: async (_ctx: HandlerContext) => ({ trigger: "x" }) });
		expect(BUILTIN_HANDLERS.noop).toBe(noopHandler);
	});
});
