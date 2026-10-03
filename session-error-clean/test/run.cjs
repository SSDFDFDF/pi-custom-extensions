const path = require("node:path");
const { createJiti } = require("jiti");
const jiti = createJiti(__filename, { interopDefault: true });
jiti(path.join(__dirname, "clean.test.mjs"));
jiti(path.join(__dirname, "sanitize.test.ts"));
