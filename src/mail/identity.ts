/**
 * Mailbox identity helpers.
 *
 * Mission capabilities sometimes differ from the canonical agent name that
 * appears in SessionStore. Mail routing must canonicalize those aliases so
 * messages land in the inbox that active agents actually read.
 */

const MAILBOX_ALIASES = new Map<string, string>([["coordinator-mission", "coordinator"]]);

/**
 * Resolve a mailbox identifier to its canonical agent name.
 */
export function canonicalizeMailAgentName(name: string): string {
	return MAILBOX_ALIASES.get(name) ?? name;
}

/**
 * Expand a mailbox identifier to all equivalent names.
 *
 * Canonical name is always returned first, followed by any known aliases.
 */
export function expandMailAgentNames(name: string): string[] {
	const canonical = canonicalizeMailAgentName(name);
	const names = [canonical];
	for (const [alias, target] of MAILBOX_ALIASES) {
		if (target === canonical && alias !== canonical) {
			names.push(alias);
		}
	}
	return names;
}
