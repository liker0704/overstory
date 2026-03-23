import type { User } from "./types.ts";

export const MIGRATIONS = [
	{
		version: 1,
		up: "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL)",
	},
];

export function getUser(id: string): User {
	return { id, name: "Test User", email: "test@example.com" };
}
