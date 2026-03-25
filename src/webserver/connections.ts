import type { DashboardStores } from "../dashboard/data.ts";
import { closeDashboardStores, openDashboardStores } from "../dashboard/data.ts";

interface PoolEntry {
	storesPromise: Promise<DashboardStores>;
	refCount: number;
	lastReleasedAt: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
}

interface ConnectionPoolDeps {
	openStores: (path: string) => DashboardStores;
	closeStores: (stores: DashboardStores) => void;
}

interface ConnectionPool {
	acquireStores: (projectPath: string, idleTtlMs?: number) => Promise<DashboardStores>;
	releaseStores: (projectPath: string, idleTtlMs?: number) => void;
	closeAllPools: () => Promise<void>;
	getPoolSize: () => number;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;

function openDashboardStoresAsync(
	path: string,
	openStores: (p: string) => DashboardStores,
): Promise<DashboardStores> {
	return Promise.resolve().then(() => openStores(path));
}

export function createConnectionPool(deps?: Partial<ConnectionPoolDeps>): ConnectionPool {
	const openStores = deps?.openStores ?? openDashboardStores;
	const closeStores = deps?.closeStores ?? closeDashboardStores;

	const pool = new Map<string, PoolEntry>();

	function acquireStores(projectPath: string, _idleTtlMs?: number): Promise<DashboardStores> {
		const existing = pool.get(projectPath);
		if (existing !== undefined) {
			existing.refCount++;
			if (existing.idleTimer !== null) {
				clearTimeout(existing.idleTimer);
				existing.idleTimer = null;
			}
			return existing.storesPromise;
		}

		const storesPromise = openDashboardStoresAsync(projectPath, openStores);

		// Poison protection: evict entry on rejection so next caller retries
		storesPromise.catch(() => {
			pool.delete(projectPath);
		});

		const entry: PoolEntry = {
			storesPromise,
			refCount: 1,
			lastReleasedAt: 0,
			idleTimer: null,
		};
		pool.set(projectPath, entry);

		return storesPromise;
	}

	function releaseStores(projectPath: string, idleTtlMs?: number): void {
		const entry = pool.get(projectPath);
		if (entry === undefined) return;

		entry.refCount--;
		if (entry.refCount > 0) return;

		entry.lastReleasedAt = Date.now();
		const ttl = idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

		entry.idleTimer = setTimeout(() => {
			const current = pool.get(projectPath);
			if (current === undefined) return;
			// Only clean up if still at zero refs
			if (current.refCount > 0) return;
			pool.delete(projectPath);
			current.storesPromise
				.then((stores) => closeStores(stores))
				.catch(() => {
					/* best effort */
				});
		}, ttl);
	}

	async function closeAllPools(): Promise<void> {
		for (const [, entry] of pool) {
			if (entry.idleTimer !== null) {
				clearTimeout(entry.idleTimer);
				entry.idleTimer = null;
			}
		}

		const entries = [...pool.values()];
		pool.clear();

		await Promise.allSettled(
			entries.map((entry) =>
				entry.storesPromise
					.then((stores) => closeStores(stores))
					.catch(() => {
						/* best effort */
					}),
			),
		);
	}

	function getPoolSize(): number {
		return pool.size;
	}

	return { acquireStores, releaseStores, closeAllPools, getPoolSize };
}

const defaultPool = createConnectionPool();
export const { acquireStores, releaseStores, closeAllPools, getPoolSize } = defaultPool;
