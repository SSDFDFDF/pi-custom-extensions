/**
 * Shared test loader.
 *
 * This Node build has no `--experimental-strip-types` (ERR_NO_TYPESCRIPT), so
 * tests load the extension's TypeScript sources through jiti — the same
 * transform Pi uses for extensions. Bare package imports resolve through normal
 * Node resolution, which finds the local `@earendil-works/pi-*` copies.
 */

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

export function load(specifier) {
	return jiti.import(specifier);
}

export const pi = await jiti.import("@earendil-works/pi-coding-agent");
export const { SessionManager, estimateTokens } = pi;
