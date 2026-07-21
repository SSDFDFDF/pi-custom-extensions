import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

// Map the bare pi package specifier to the real installed dist so tests can
// import runtime constants (DEFAULT_MAX_BYTES, formatSize, ...).
const PI_PKG = "@earendil-works/pi-coding-agent";
const PI_DIST =
  "/home/xjc/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const TYPEBOX_PKG = "typebox";
const TYPEBOX_DIST =
  "/home/xjc/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/index.mjs";
const PI_TUI_PKG = "@earendil-works/pi-tui";
const PI_TUI_DIST =
  "/home/xjc/.local/share/pi-node/node-v22.23.1-linux-x64/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js";

// Map relative ".js" specifiers to sibling ".ts" sources when the .js does not
// exist. Lets the .ts test suite import "./foo.js" and resolve "./foo.ts".
export async function resolve(specifier, context, nextResolve) {
  if (specifier === PI_PKG && existsSync(PI_DIST)) {
    return nextResolve(pathToFileURL(PI_DIST).href, context);
  }
  if (specifier === PI_TUI_PKG && existsSync(PI_TUI_DIST)) {
    return nextResolve(pathToFileURL(PI_TUI_DIST).href, context);
  }
  if (specifier === TYPEBOX_PKG && existsSync(TYPEBOX_DIST)) {
    return nextResolve(pathToFileURL(TYPEBOX_DIST).href, context);
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const base = new URL(specifier, pathToFileURL(parentPath));
    if (!existsSync(fileURLToPath(base))) {
      const tsUrl = new URL(specifier.slice(0, -3) + ".ts", pathToFileURL(parentPath));
      if (existsSync(fileURLToPath(tsUrl))) {
        return nextResolve(tsUrl.href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
