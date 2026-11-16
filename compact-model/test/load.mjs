/**
 * Shared test loader.
 *
 * This Node build has no `--experimental-strip-types` (ERR_NO_TYPESCRIPT), so
 * tests load the extension's TypeScript sources through jiti — the same
 * transform Pi uses for extensions. Bare package imports resolve through normal
 * Node resolution (~/node_modules), whose 1.0.4 copy of
 * @earendil-works/pi-coding-agent has identical shapes for everything we use.
 */

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

export function load(specifier) {
	return jiti.import(specifier);
}
