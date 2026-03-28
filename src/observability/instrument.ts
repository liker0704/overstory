import type { EventStore, InsertEvent } from "../events/types.js";

/** Context needed to emit instrumented events for ecosystem tool calls. */
export interface InstrumentContext {
	eventStore: EventStore;
	agentName: string;
	runId: string | null;
	sessionId: string | null;
}

function emitStart(
	ctx: InstrumentContext,
	tool: string,
	command: string,
	argsSummary: string,
): void {
	const event: InsertEvent = {
		runId: ctx.runId,
		agentName: ctx.agentName,
		sessionId: ctx.sessionId,
		eventType: "tool_start",
		toolName: `${tool}:${command}`,
		toolArgs: JSON.stringify({
			summary: argsSummary,
			"ecosystem.tool": tool,
			"ecosystem.command": command,
		}),
		toolDurationMs: null,
		level: "info",
		data: JSON.stringify({
			"ecosystem.tool": tool,
			"ecosystem.command": command,
			"ecosystem.args_summary": argsSummary,
		}),
	};
	ctx.eventStore.insert(event);
}

function emitEnd(
	ctx: InstrumentContext,
	tool: string,
	command: string,
	exitCode: number,
	durationMs: number,
): void {
	const event: InsertEvent = {
		runId: ctx.runId,
		agentName: ctx.agentName,
		sessionId: ctx.sessionId,
		eventType: "tool_end",
		toolName: `${tool}:${command}`,
		toolArgs: null,
		toolDurationMs: durationMs,
		level: exitCode === 0 ? "info" : "warn",
		data: JSON.stringify({
			"ecosystem.tool": tool,
			"ecosystem.command": command,
			"ecosystem.exit_code": exitCode,
			"ecosystem.duration_ms": durationMs,
		}),
	};
	ctx.eventStore.insert(event);
}

/**
 * Wrap an async operation with tool_start/tool_end event emission.
 * If no InstrumentContext is provided, the operation runs without instrumentation.
 */
export async function withEcosystemSpan<T>(
	ctx: InstrumentContext | undefined,
	tool: string,
	command: string,
	argsSummary: string,
	fn: () => Promise<T>,
): Promise<T> {
	if (!ctx) {
		return fn();
	}

	const start = Date.now();
	emitStart(ctx, tool, command, argsSummary);

	let exitCode = 0;
	try {
		return await fn();
	} catch (err) {
		exitCode = 1;
		throw err;
	} finally {
		emitEnd(ctx, tool, command, exitCode, Date.now() - start);
	}
}
