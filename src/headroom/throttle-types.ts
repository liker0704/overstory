export type ThrottleLevel = "none" | "warn" | "slow" | "pause";

export interface ThrottleAction {
	level: ThrottleLevel;
	targetAgent: string;
	reason: string;
	runtime: string;
}

export interface ThrottlePolicy {
	/** Headroom % below which to slow spawning (reduce maxConcurrent). Default: 20. */
	slowThresholdPercent: number;
	/** Headroom % below which to pause non-essential agents. Default: 10. */
	pauseThresholdPercent: number;
	/** Whether to block new spawns when below pause threshold. Default: true. */
	blockSpawnsOnPause: boolean;
}

export interface ThrottleState {
	level: ThrottleLevel;
	since: string; // ISO timestamp
	affectedAgents: string[];
	triggeringRuntime: string;
}
