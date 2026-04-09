import { CSS } from "./css.ts";
import { HTMX_JS } from "./htmx.ts";
import { CLIENT_JS } from "./js.ts";

/** Compute a short content hash for cache-busting static assets. */
function contentHash(content: string): string {
	const hasher = new Bun.CryptoHasher("md5");
	hasher.update(content);
	return hasher.digest("hex").slice(0, 8);
}

export const CSS_HASH = contentHash(CSS);
export const JS_HASH = contentHash(CLIENT_JS);
export const HTMX_HASH = contentHash(HTMX_JS);

export const CSS_URL = `/static/css?v=${CSS_HASH}`;
export const JS_URL = `/static/js?v=${JS_HASH}`;
export const HTMX_URL = `/static/htmx?v=${HTMX_HASH}`;
