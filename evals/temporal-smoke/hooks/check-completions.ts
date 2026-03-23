import type { EvalContext } from "../../../src/eval/types.ts";

export default function (context: EvalContext): { passed: boolean; message: string } {
	const completed = context.events.filter((e) => e.eventType === "session_end");
	const passed = completed.length >= 2;
	return {
		passed,
		message: passed
			? `${completed.length} sessions completed`
			: `Only ${completed.length} sessions completed, expected >= 2`,
	};
}
