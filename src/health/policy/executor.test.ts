import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAutoResume, executePolicyAction } from "./executor.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "policy-executor-test-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function makeContext(mailSend = mock(() => {})) {
	return {
		overstoryDir: tempDir,
		mailSend,
	};
}

// 1. pause_spawning writes sentinel file with ruleId and timestamp
test("pause_spawning writes sentinel file with ruleId and timestamp", async () => {
	const ctx = makeContext();
	const result = await executePolicyAction("pause_spawning", "rule-1", ctx, false);

	expect(result.executed).toBe(true);
	const sentinelPath = join(tempDir, "spawn-paused");
	expect(existsSync(sentinelPath)).toBe(true);

	const data = JSON.parse(readFileSync(sentinelPath, "utf-8")) as {
		ruleId: string;
		pausedAt: string;
	};
	expect(data.ruleId).toBe("rule-1");
	expect(typeof data.pausedAt).toBe("string");
	expect(new Date(data.pausedAt).getTime()).toBeLessThanOrEqual(Date.now());
});

// 2. pause_spawning is idempotent (writing twice doesn't error)
test("pause_spawning is idempotent", async () => {
	const ctx = makeContext();
	const r1 = await executePolicyAction("pause_spawning", "rule-1", ctx, false);
	const r2 = await executePolicyAction("pause_spawning", "rule-2", ctx, false);

	expect(r1.executed).toBe(true);
	expect(r2.executed).toBe(true);

	// ruleId should remain from first write (file already existed, no-op)
	const data = JSON.parse(readFileSync(join(tempDir, "spawn-paused"), "utf-8")) as {
		ruleId: string;
	};
	expect(data.ruleId).toBe("rule-1");
});

// 3. resume_spawning removes sentinel file
test("resume_spawning removes sentinel file", async () => {
	const sentinelPath = join(tempDir, "spawn-paused");
	writeFileSync(
		sentinelPath,
		JSON.stringify({ ruleId: "rule-1", pausedAt: new Date().toISOString() }),
	);

	const ctx = makeContext();
	const result = await executePolicyAction("resume_spawning", "rule-2", ctx, false);

	expect(result.executed).toBe(true);
	expect(existsSync(sentinelPath)).toBe(false);
});

// 4. resume_spawning is idempotent (removing non-existent file doesn't error)
test("resume_spawning is idempotent when sentinel absent", async () => {
	const ctx = makeContext();
	const result = await executePolicyAction("resume_spawning", "rule-1", ctx, false);

	expect(result.executed).toBe(true);
	expect(result.error).toBeUndefined();
});

// 5. prioritize_merger sends mail with correct type and payload
test("prioritize_merger sends mail with correct type and payload", async () => {
	const mailSend = mock(() => {});
	const result = await executePolicyAction(
		"prioritize_merger",
		"rule-1",
		makeContext(mailSend),
		false,
	);

	expect(result.executed).toBe(true);
	expect(mailSend).toHaveBeenCalledTimes(1);

	const [to, subject, , type, payload] = (mailSend.mock.calls[0] ?? []) as string[];
	expect(to).toBe("coordinator");
	expect(subject).toBe("health_policy: prioritize_merger");
	expect(type).toBe("health_policy_action");

	const parsed = JSON.parse(payload ?? "{}") as { ruleId: string; action: string };
	expect(parsed.ruleId).toBe("rule-1");
	expect(parsed.action).toBe("prioritize_merger");
});

// 6. escalate_mission_refresh sends mail with correct type and payload
test("escalate_mission_refresh sends mail with correct type and payload", async () => {
	const mailSend = mock(() => {});
	const result = await executePolicyAction(
		"escalate_mission_refresh",
		"rule-2",
		makeContext(mailSend),
		false,
	);

	expect(result.executed).toBe(true);
	expect(mailSend).toHaveBeenCalledTimes(1);

	const [to, subject, , type, payload] = (mailSend.mock.calls[0] ?? []) as string[];
	expect(to).toBe("coordinator");
	expect(subject).toBe("health_policy: escalate_mission_refresh");
	expect(type).toBe("health_policy_action");

	const parsed = JSON.parse(payload ?? "{}") as { ruleId: string; action: string };
	expect(parsed.ruleId).toBe("rule-2");
	expect(parsed.action).toBe("escalate_mission_refresh");
});

// 7. trigger_recovery sends mail with correct type and payload
test("trigger_recovery sends mail with correct type and payload", async () => {
	const mailSend = mock(() => {});
	const result = await executePolicyAction(
		"trigger_recovery",
		"rule-3",
		makeContext(mailSend),
		false,
	);

	expect(result.executed).toBe(true);
	expect(mailSend).toHaveBeenCalledTimes(1);

	const [to, subject, , type, payload] = (mailSend.mock.calls[0] ?? []) as string[];
	expect(to).toBe("coordinator");
	expect(subject).toBe("health_policy: trigger_recovery");
	expect(type).toBe("health_policy_action");

	const parsed = JSON.parse(payload ?? "{}") as { ruleId: string; action: string };
	expect(parsed.ruleId).toBe("rule-3");
	expect(parsed.action).toBe("trigger_recovery");
});

// 8. dry-run mode: no side effects, returns executed=false
describe("dry-run mode", () => {
	test("pause_spawning dry-run: no sentinel written", async () => {
		const ctx = makeContext();
		const result = await executePolicyAction("pause_spawning", "rule-1", ctx, true);

		expect(result.executed).toBe(false);
		expect(result.details).toContain("dry-run");
		expect(existsSync(join(tempDir, "spawn-paused"))).toBe(false);
	});

	test("prioritize_merger dry-run: no mail sent", async () => {
		const mailSend = mock(() => {});
		const result = await executePolicyAction(
			"prioritize_merger",
			"rule-1",
			makeContext(mailSend),
			true,
		);

		expect(result.executed).toBe(false);
		expect(mailSend).not.toHaveBeenCalled();
	});
});

// 9. checkAutoResume removes stale sentinel and returns resumed=true
test("checkAutoResume removes stale sentinel and returns resumed=true", () => {
	const sentinelPath = join(tempDir, "spawn-paused");
	const staleDate = new Date(Date.now() - 10_000).toISOString();
	writeFileSync(sentinelPath, JSON.stringify({ ruleId: "rule-1", pausedAt: staleDate }));

	const result = checkAutoResume(tempDir, 5_000);

	expect(result.resumed).toBe(true);
	expect(result.details).toContain("auto-resumed after");
	expect(existsSync(sentinelPath)).toBe(false);
});

// 10. checkAutoResume does nothing for fresh sentinel
test("checkAutoResume does nothing for fresh sentinel", () => {
	const sentinelPath = join(tempDir, "spawn-paused");
	const freshDate = new Date().toISOString();
	writeFileSync(sentinelPath, JSON.stringify({ ruleId: "rule-1", pausedAt: freshDate }));

	const result = checkAutoResume(tempDir, 60_000);

	expect(result.resumed).toBe(false);
	expect(existsSync(sentinelPath)).toBe(true);
});

// 11. checkAutoResume handles corrupt sentinel file gracefully
test("checkAutoResume handles corrupt sentinel gracefully", () => {
	const sentinelPath = join(tempDir, "spawn-paused");
	writeFileSync(sentinelPath, "not-valid-json!!!");

	const result = checkAutoResume(tempDir, 5_000);

	expect(result.resumed).toBe(true);
	expect(result.details).toContain("corrupt");
	expect(existsSync(sentinelPath)).toBe(false);
});
