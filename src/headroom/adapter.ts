import type { AgentRuntime } from "../runtimes/types.ts";
import type { HeadroomSnapshot, HeadroomStore } from "./types.ts";

export interface HeadroomAdapterDeps {
	store: HeadroomStore;
	runtimes: AgentRuntime[];
}

/** Query all runtimes that implement queryHeadroom and cache results. */
export async function pollHeadroom(deps: HeadroomAdapterDeps): Promise<HeadroomSnapshot[]> {
	const snapshots: HeadroomSnapshot[] = [];

	const promises = deps.runtimes
		.filter(
			(rt): rt is AgentRuntime & { queryHeadroom(): Promise<HeadroomSnapshot> } =>
				typeof rt.queryHeadroom === "function",
		)
		.map(async (rt) => {
			try {
				const snapshot = await rt.queryHeadroom();
				deps.store.upsert(snapshot);
				snapshots.push(snapshot);
			} catch {
				// Individual runtime failure doesn't block others
			}
		});

	await Promise.all(promises);
	return snapshots;
}
