import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
// PI_PACKAGE_DIR tests against an installed Pi (e.g. a global install) instead of the pinned devDependency.
const piDir = process.env.PI_PACKAGE_DIR ?? join(root, "node_modules/@earendil-works/pi-coding-agent");
const require = createRequire(join(piDir, "package.json"));
export const piVersion = require(join(piDir, "package.json")).version;
export const tuiPath = require.resolve("@earendil-works/pi-tui");
const jiti = require("jiti").createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-tui": tuiPath, "@earendil-works/pi-coding-agent": join(piDir, "dist/index.js") },
});
export const tui = await import(tuiPath);
export const load = (path) => jiti.import(join(root, path));
export const plainTheme = new Proxy(
	{},
	{ get: (_t, key) => (key === "highlightCode" || key === "codeBlockIndent" ? undefined : (s) => s) },
);
