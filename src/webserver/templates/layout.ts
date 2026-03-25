/**
 * HTML template primitives: escaping, tagged template literal, and layout.
 */

/** HTML entity escaper — encodes & < > " ' */
export function esc(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Wraps pre-escaped HTML to bypass auto-escape in the html tag. */
export class Raw {
	readonly value: string;

	constructor(value: string) {
		this.value = value;
	}

	toString(): string {
		return this.value;
	}
}

/**
 * Tagged template literal that auto-escapes interpolated values unless they are Raw instances.
 * Returns a Raw so nested calls compose safely.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
	let result = "";
	for (let i = 0; i < strings.length; i++) {
		result += strings[i] ?? "";
		if (i < values.length) {
			const val = values[i];
			if (val instanceof Raw) {
				result += val.value;
			} else if (val === null || val === undefined) {
				// omit nullish
			} else {
				result += esc(String(val));
			}
		}
	}
	return new Raw(result);
}

interface LayoutOptions {
	activeNav?: string;
	slug?: string;
}

/** Renders a full HTML5 page with header, nav, main, and scripts. */
export function layout(title: string, body: Raw, options: LayoutOptions = {}): string {
	const { activeNav, slug } = options;

	const navLinks = slug
		? [
				{ label: "Overview", href: `/project/${slug}` },
				{ label: "Agents", href: `/project/${slug}/agents` },
				{ label: "Missions", href: `/project/${slug}/missions` },
				{ label: "Mail", href: `/project/${slug}/mail` },
				{ label: "Merge", href: `/project/${slug}/merge` },
				{ label: "Events", href: `/project/${slug}/events` },
			]
		: [{ label: "Home", href: "/" }];

	const navHtml = navLinks
		.map((link) => {
			const isActive = activeNav === link.label;
			const cls = isActive ? ' class="nav-item nav-active"' : ' class="nav-item"';
			return html`<a href="${link.href}"${new Raw(cls)}>${link.label}</a>`.value;
		})
		.join("\n\t\t\t");

	return html`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${title}</title>
	<link rel="stylesheet" href="/static/css">
</head>
<body>
	<header>
		<h1>${title}</h1>
		<nav>
			${new Raw(navHtml)}
		</nav>
	</header>
	<main>
		${body}
	</main>
	<script src="/static/htmx"></script>
	<script src="/static/js"></script>
</body>
</html>`.value;
}
