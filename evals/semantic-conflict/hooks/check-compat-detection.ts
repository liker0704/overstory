import type { EvalContext } from "../../../src/eval/types.ts";

export default async function checkCompatDetection(
	context: EvalContext,
): Promise<{ passed: boolean; message: string }> {
	const compatEvent = context.events.find(
		(e) =>
			e.agentName === "compat-gate" &&
			e.eventType === "custom" &&
			e.data !== null &&
			(e.data.includes("reject") || e.data.includes("breaking")),
	);

	if (compatEvent) {
		return {
			passed: true,
			message: `Compat gate detected breaking change and emitted reject decision`,
		};
	}

	return {
		passed: false,
		message: "No compat-gate event with reject or breaking found in event timeline",
	};
}
