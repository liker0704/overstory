#!/usr/bin/env bash
set -e

SUBCOMMAND="${1:-}"

create_branch_a() {
	git checkout -b overstory/worker-a/task-a

	# Remove email from User interface
	sed -i '/email: string;/d' src/types.ts

	# Rewrite service.ts without email references
	cat > src/service.ts << 'EOF'
import { getUser } from "./store.ts";
import type { User } from "./types.ts";

export function formatUserLabel(user: User): string {
	return user.name;
}

export function lookupAndFormat(id: string): string {
	return formatUserLabel(getUser(id));
}
EOF

	git add -A
	git commit -m "feat: remove deprecated email field"
}

create_branch_b() {
	git checkout main

	git checkout -b overstory/worker-b/task-b

	# Add second migration to store.ts MIGRATIONS
	sed -i 's/];$/	{\n\t\tversion: 2,\n\t\tup: "ALTER TABLE users ADD COLUMN notified INTEGER NOT NULL DEFAULT 0",\n\t},\n];/' src/store.ts

	# Append notifyUser function that uses user.email to end of service.ts
	cat >> src/service.ts << 'EOF'

export function notifyUser(user: User): string {
	return `Sending notification to ${user.email}`;
}
EOF

	git add -A
	git commit -m "feat: add user notification support"

	git checkout main
}

case "$SUBCOMMAND" in
	create-branch-a)
		create_branch_a
		;;
	create-branch-b)
		create_branch_b
		;;
	*)
		echo "Usage: $0 <create-branch-a|create-branch-b>" >&2
		exit 1
		;;
esac
