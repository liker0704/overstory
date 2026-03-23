import { existsSync } from "node:fs";
import { join } from "node:path";

export function isPolicyDisabled(
	overstoryDir: string,
	config: { healthPolicy?: { enabled: boolean } },
): boolean {
	if (config.healthPolicy?.enabled !== true) {
		return true;
	}
	const sentinelPath = join(overstoryDir, "health-policy-disabled");
	return existsSync(sentinelPath);
}
