/**
 * Tests for src/commands/review.ts
 *
 * Verifies command structure: name, subcommands exist, options are registered.
 * Does not require a real database or file system.
 */

import { describe, expect, test } from "bun:test";
import { createReviewCommand } from "./review.ts";

describe("createReviewCommand", () => {
	test("returns a command named 'review'", () => {
		const cmd = createReviewCommand();
		expect(cmd.name()).toBe("review");
	});

	test("has description", () => {
		const cmd = createReviewCommand();
		expect(cmd.description()).toBeTruthy();
	});

	test("has 'sessions' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "sessions");
		expect(sub).toBeDefined();
	});

	test("has 'session' subcommand with argument", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "session");
		expect(sub).toBeDefined();
	});

	test("has 'handoffs' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "handoffs");
		expect(sub).toBeDefined();
	});

	test("has 'specs' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "specs");
		expect(sub).toBeDefined();
	});

	test("has 'missions' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "missions");
		expect(sub).toBeDefined();
	});

	test("has 'mission' subcommand with argument", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "mission");
		expect(sub).toBeDefined();
	});

	test("has 'stale' subcommand", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "stale");
		expect(sub).toBeDefined();
	});

	test("sessions subcommand has --recent option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "sessions");
		const opts = sub?.options ?? [];
		const recentOpt = opts.find((o) => o.long === "--recent");
		expect(recentOpt).toBeDefined();
	});

	test("sessions subcommand has --json option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "sessions");
		const opts = sub?.options ?? [];
		const jsonOpt = opts.find((o) => o.long === "--json");
		expect(jsonOpt).toBeDefined();
	});

	test("specs subcommand has --json option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "specs");
		const opts = sub?.options ?? [];
		const jsonOpt = opts.find((o) => o.long === "--json");
		expect(jsonOpt).toBeDefined();
	});

	test("stale subcommand has --json option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "stale");
		const opts = sub?.options ?? [];
		const jsonOpt = opts.find((o) => o.long === "--json");
		expect(jsonOpt).toBeDefined();
	});

	test("missions subcommand has --recent option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "missions");
		const opts = sub?.options ?? [];
		const recentOpt = opts.find((o) => o.long === "--recent");
		expect(recentOpt).toBeDefined();
	});

	test("mission subcommand has --json option", () => {
		const cmd = createReviewCommand();
		const sub = cmd.commands.find((c) => c.name() === "mission");
		const opts = sub?.options ?? [];
		const jsonOpt = opts.find((o) => o.long === "--json");
		expect(jsonOpt).toBeDefined();
	});

	test("has exactly 7 subcommands", () => {
		const cmd = createReviewCommand();
		expect(cmd.commands).toHaveLength(7);
	});
});
