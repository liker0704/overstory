// === Canopy CLI Results ===

/** A single section within a rendered canopy prompt. */
export interface CanopyPromptSection {
	name: string;
	body: string;
}

/** Summary of a canopy prompt as returned by list/show. */
export interface CanopyPromptSummary {
	id: string;
	name: string;
	version: number;
	sections: CanopyPromptSection[];
}

/** Result from cn render — resolved prompt with all inheritance applied. */
export interface CanopyRenderResult {
	success: boolean;
	name: string;
	version: number;
	sections: CanopyPromptSection[];
}

/** Result from cn validate — validation status and errors. */
export interface CanopyValidateResult {
	success: boolean;
	errors: string[];
}

/** Result from cn list — list of all prompts. */
export interface CanopyListResult {
	success: boolean;
	prompts: CanopyPromptSummary[];
}

/** Result from cn show — single prompt record. */
export interface CanopyShowResult {
	success: boolean;
	prompt: CanopyPromptSummary;
}
