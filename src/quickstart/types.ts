/** Status of a single quickstart step. */
export type StepStatus = "pending" | "complete" | "skipped" | "failed";

/** Result returned by a step's run() function. */
export interface StepResult {
	status: StepStatus;
	message?: string;
	details?: string[];
}

/** Definition of a single quickstart wizard step. */
export interface QuickstartStep {
	id: string;
	title: string;
	description: string;
	/** Detect whether this step has already been completed. */
	check: () => Promise<StepStatus>;
	/** Execute this step. */
	run: () => Promise<StepResult>;
	/** Force skip this step. */
	skip?: boolean;
}

/** Options controlling quickstart wizard behavior. */
export interface QuickstartOptions {
	/** Auto-accept all prompts without asking. */
	yes?: boolean;
	/** Show full subprocess output. */
	verbose?: boolean;
	/** Output results as JSON. */
	json?: boolean;
}
