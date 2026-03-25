export interface WebConfig {
	port: number;
	host: string;
	pollIntervalMs: number;
	connectionTtlMs: number;
	discoveryPaths: string[];
}

export interface ProjectEntry {
	slug: string;
	name: string;
	path: string;
	addedAt: string;
	lastSeenAt: string;
}

export interface ProjectRegistry {
	projects: ProjectEntry[];
	discoveryPaths: string[];
}

export interface Route {
	method: "GET" | "POST";
	pattern: URLPattern;
	handler: (req: Request, params: Record<string, string>) => Promise<Response>;
}

export interface ActionResult {
	success: boolean;
	output: string;
	error?: string;
}
