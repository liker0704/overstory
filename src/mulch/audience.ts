const CAPABILITY_AUDIENCE_MAP: Record<string, string> = {
	builder: "builder",
	scout: "scout",
	reviewer: "reviewer",
	lead: "lead",
	"lead-mission": "lead",
	coordinator: "coordinator",
	"coordinator-mission": "coordinator",
	"coordinator-mission-assess": "coordinator",
	"coordinator-mission-direct": "coordinator",
	"coordinator-mission-planned": "coordinator",
	merger: "merger",
	architect: "architect",
	tester: "tester",
	"mission-analyst": "analyst",
	"execution-director": "coordinator",
	monitor: "all",
	"research-lead": "all",
	researcher: "all",
};

export function capabilityToAudience(capability: string): string | undefined {
	const direct = CAPABILITY_AUDIENCE_MAP[capability];
	if (direct) return direct;
	if (capability.startsWith("plan-")) return "architect";
	return undefined;
}
