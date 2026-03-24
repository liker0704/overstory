export interface ResearchConfig {
	maxResearchers?: number; // default 5, hard cap 20
	researcherModel?: "opus" | "sonnet" | "haiku"; // default 'opus'
	researcherConcurrency?: number; // default 3, max simultaneous researchers
	defaultProvider?: "exa" | "brave";
	outputDir?: string; // default '.overstory/research'
}

export interface McpServerConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	disabled?: boolean;
}

export interface ResearchReport {
	topic: string;
	slug: string;
	status: "running" | "completed" | "failed" | "stopped";
	startedAt: string;
	completedAt?: string;
	agentName: string;
	researchers: number;
	sourcesCount: number;
}

export interface ResearchSession {
	slug: string;
	topic: string;
	agentName: string;
	status: ResearchReport["status"];
	startedAt: string;
	reportPath: string;
}
