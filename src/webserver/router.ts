import type { Route } from "./types.ts";

export function createRouter(routes: Route[]): (req: Request) => Promise<Response> {
	return async (req: Request): Promise<Response> => {
		const url = req.url;
		let pathMatched = false;

		for (const route of routes) {
			const match = route.pattern.exec(url);
			if (match === null) continue;

			pathMatched = true;

			if (req.method !== route.method) continue;

			const groups = match.pathname.groups;
			const params: Record<string, string> = {};
			for (const [key, value] of Object.entries(groups)) {
				if (value !== undefined) {
					params[key] = value;
				}
			}

			return route.handler(req, params);
		}

		if (pathMatched) {
			return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
				status: 405,
				headers: { "Content-Type": "application/json" },
			});
		}

		return new Response(JSON.stringify({ error: "Not Found" }), {
			status: 404,
			headers: { "Content-Type": "application/json" },
		});
	};
}
