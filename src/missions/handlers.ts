/**
 * Built-in handler registry for mission graph execution.
 *
 * Handlers are pure async functions that receive a HandlerContext and return
 * a HandlerResult indicating which graph edge trigger to fire next.
 *
 * Handler keys are hard-coded constants — never loaded from external input.
 */

import type { HandlerContext, HandlerRegistry, HandlerResult } from "./types.ts";

// === Built-in handlers ===

/**
 * No-op handler — fires the 'default' trigger without side effects.
 * Used for passthrough nodes where the graph should advance automatically.
 */
export async function noopHandler(_ctx: HandlerContext): Promise<HandlerResult> {
	return { trigger: "default" };
}

// === Registry ===

/** Built-in handlers provided by default. Keys are hard-coded constants. */
export const BUILTIN_HANDLERS: HandlerRegistry = {
	noop: noopHandler,
};

/**
 * Create a handler registry by merging built-in handlers with optional overrides.
 *
 * Overrides shadow built-in keys. The returned registry is a plain object — safe
 * to pass as a DI dep.
 */
export function createHandlerRegistry(overrides?: HandlerRegistry): HandlerRegistry {
	return { ...BUILTIN_HANDLERS, ...overrides };
}
