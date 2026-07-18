/**
 * Node loader: when a hybrid-goal src module imports "./foo.js", try "./foo.ts".
 * Enables importing goal.ts under `node --experimental-strip-types` without a bundler.
 */
export async function resolve(specifier, context, nextResolve) {
	if (
		specifier.endsWith(".js") &&
		!specifier.includes("node_modules") &&
		typeof context.parentURL === "string" &&
		context.parentURL.includes("/hybrid-goal/src/")
	) {
		const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
		try {
			return await nextResolve(tsSpecifier, context);
		} catch {
			// fall through
		}
	}
	return nextResolve(specifier, context);
}
