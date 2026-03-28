import { describe, expect, test } from "bun:test";
import type { EventStore, InsertEvent, StoredEvent, ToolStats } from "../events/types.js";
import { type InstrumentContext, withEcosystemSpan } from "./instrument.js";

/**
 * Create a mock EventStore that records inserted events.
 */
function createMockEventStore(): EventStore & { events: InsertEvent[] } {
	const events: InsertEvent[] = [];
	return {
		events,
		insert(event: InsertEvent): number {
			events.push(event);
			return events.length;
		},
		correlateToolEnd() {
			return null;
		},
		getByAgent(): StoredEvent[] {
			return [];
		},
		getByRun(): StoredEvent[] {
			return [];
		},
		getErrors(): StoredEvent[] {
			return [];
		},
		getTimeline(): StoredEvent[] {
			return [];
		},
		getToolStats(): ToolStats[] {
			return [];
		},
		purge(): number {
			return 0;
		},
		close(): void {},
	};
}

function makeCtx(store: EventStore): InstrumentContext {
	return {
		eventStore: store,
		agentName: "test-agent",
		runId: "run-123",
		sessionId: "session-456",
	};
}

describe("withEcosystemSpan", () => {
	test("without context: fn runs normally, no events emitted", async () => {
		const store = createMockEventStore();
		const result = await withEcosystemSpan(undefined, "mulch", "prime", "prime", async () => 42);
		expect(result).toBe(42);
		expect(store.events).toHaveLength(0);
	});

	test("with context: emits tool_start and tool_end events", async () => {
		const store = createMockEventStore();
		const ctx = makeCtx(store);

		await withEcosystemSpan(ctx, "mulch", "prime", "prime domains", async () => "ok");

		expect(store.events).toHaveLength(2);
		const [start, end] = store.events;
		expect(start?.eventType).toBe("tool_start");
		expect(end?.eventType).toBe("tool_end");
	});

	test("toolName format is 'tool:command'", async () => {
		const store = createMockEventStore();
		const ctx = makeCtx(store);

		await withEcosystemSpan(ctx, "mulch", "prime", "prime", async () => null);

		const [start, end] = store.events;
		expect(start?.toolName).toBe("mulch:prime");
		expect(end?.toolName).toBe("mulch:prime");
	});

	test("tool_start data has ecosystem attributes", async () => {
		const store = createMockEventStore();
		const ctx = makeCtx(store);

		await withEcosystemSpan(ctx, "beads", "show", "bd-123", async () => null);

		const start = store.events[0];
		expect(start?.eventType).toBe("tool_start");
		const data = JSON.parse(start?.data ?? "{}") as Record<string, unknown>;
		expect(data["ecosystem.tool"]).toBe("beads");
		expect(data["ecosystem.command"]).toBe("show");
		expect(data["ecosystem.args_summary"]).toBe("bd-123");
	});

	test("tool_end data has exit_code and duration_ms", async () => {
		const store = createMockEventStore();
		const ctx = makeCtx(store);

		await withEcosystemSpan(ctx, "canopy", "render", "builder", async () => null);

		const end = store.events[1];
		expect(end?.eventType).toBe("tool_end");
		const data = JSON.parse(end?.data ?? "{}") as Record<string, unknown>;
		expect(data["ecosystem.tool"]).toBe("canopy");
		expect(data["ecosystem.command"]).toBe("render");
		expect(data["ecosystem.exit_code"]).toBe(0);
		expect(typeof data["ecosystem.duration_ms"]).toBe("number");
	});

	test("tool_end toolDurationMs is set", async () => {
		const store = createMockEventStore();
		const ctx = makeCtx(store);

		await withEcosystemSpan(ctx, "mulch", "record", "record typescript", async () => null);

		const end = store.events[1];
		expect(typeof end?.toolDurationMs).toBe("number");
		expect((end?.toolDurationMs ?? -1) >= 0).toBe(true);
	});

	test("tool_start level is info", async () => {
		const store = createMockEventStore();
		const ctx = makeCtx(store);

		await withEcosystemSpan(ctx, "mulch", "status", "status", async () => null);

		const start = store.events[0];
		expect(start?.level).toBe("info");
	});

	test("tool_end level is info on success (exit 0)", async () => {
		const store = createMockEventStore();
		const ctx = makeCtx(store);

		await withEcosystemSpan(ctx, "mulch", "status", "status", async () => null);

		const end = store.events[1];
		expect(end?.level).toBe("info");
	});

	test("on error: tool_end emitted with exitCode=1, error re-thrown", async () => {
		const store = createMockEventStore();
		const ctx = makeCtx(store);

		await expect(
			withEcosystemSpan(ctx, "beads", "create", "create issue", async () => {
				throw new Error("create failed");
			}),
		).rejects.toThrow("create failed");

		expect(store.events).toHaveLength(2);
		const end = store.events[1];
		expect(end?.eventType).toBe("tool_end");
		const data = JSON.parse(end?.data ?? "{}") as Record<string, unknown>;
		expect(data["ecosystem.exit_code"]).toBe(1);
		expect(end?.level).toBe("warn");
	});

	test("tool_start toolArgs includes ecosystem attributes", async () => {
		const store = createMockEventStore();
		const ctx = makeCtx(store);

		await withEcosystemSpan(ctx, "mulch", "search", "my query", async () => null);

		const start = store.events[0];
		const toolArgs = JSON.parse(start?.toolArgs ?? "{}") as Record<string, unknown>;
		expect(toolArgs["ecosystem.tool"]).toBe("mulch");
		expect(toolArgs["ecosystem.command"]).toBe("search");
		expect(toolArgs.summary).toBe("my query");
	});

	test("events carry correct agentName, runId, sessionId", async () => {
		const store = createMockEventStore();
		const ctx: InstrumentContext = {
			eventStore: store,
			agentName: "my-agent",
			runId: "run-abc",
			sessionId: "sess-xyz",
		};

		await withEcosystemSpan(ctx, "mulch", "prime", "prime", async () => null);

		for (const event of store.events) {
			expect(event.agentName).toBe("my-agent");
			expect(event.runId).toBe("run-abc");
			expect(event.sessionId).toBe("sess-xyz");
		}
	});
});
