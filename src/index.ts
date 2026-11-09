// Semantic copy for fullscreen mode: mouse selections, multi-clicks and a keyboard copy mode copy the text
// behind the rendering (no quote gutters, table borders or hard wraps). Falls back to Pi's copy on any failure.
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { CopyMode } from "./copy-mode.ts";
import { install, settings } from "./patch.ts";

// Keep in step with the pinned devDependency and the CI matrix.
const TESTED_PI = "1.5.";

export default function (pi: ExtensionAPI) {
	const problem = install();
	const untested = VERSION.startsWith(TESTED_PI)
		? undefined
		: `semantic-copy is tested with Pi ${TESTED_PI}x, this is ${VERSION}. If copies look wrong, run /semantic-copy off.`;

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" || !ctx.hasUI) return;
		const warning = problem ?? untested;
		if (warning) ctx.ui.notify(warning, "warning");
	});

	const open = async (ctx: any, blockMode: boolean) => {
		if (problem) return ctx.ui.notify(problem, "warning");
		if (!ctx.hasUI) return;
		await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: () => void) => {
			if (!(tui instanceof TuiAltScreen)) {
				done();
				ctx.ui.notify("copy mode needs fullscreen mode (tuiMode: fullscreen)", "warning");
				return { render: () => [], handleInput() {}, invalidate() {} };
			}
			return new CopyMode(tui, theme, done, blockMode);
		});
	};

	pi.registerCommand("copy-mode", {
		description: "Keyboard copy mode over the transcript (vim keys; y copies plain text, Y markdown)",
		handler: async (_args, ctx) => open(ctx, false),
	});
	pi.registerCommand("copy-block", {
		description: "Pick a block ({ } to move) and copy it (y plain, Y markdown)",
		handler: async (_args, ctx) => open(ctx, true),
	});
	pi.registerShortcut("alt+c", {
		description: "Enter copy mode",
		handler: async (ctx) => open(ctx, false),
	});
	pi.registerCommand("semantic-copy", {
		description: "Mouse copy format: plain | markdown | off",
		getArgumentCompletions: (prefix: string) =>
			["plain", "markdown", "off"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const next = args.trim();
			if (next === "plain" || next === "markdown" || next === "off") settings.mode = next;
			else if (next) return ctx.ui.notify("usage: /semantic-copy plain|markdown|off", "warning");
			const status = problem ?? [`semantic copy: ${settings.mode}`, untested].filter(Boolean).join("\n");
			ctx.ui.notify(status, problem || untested ? "warning" : "info");
		},
	});
}

