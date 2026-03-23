import { getUser } from "./store.ts";
import type { User } from "./types.ts";

export function formatUserLabel(user: User): string {
	return `${user.name} <${user.email}>`;
}

export function lookupAndFormat(id: string): string {
	return formatUserLabel(getUser(id));
}
