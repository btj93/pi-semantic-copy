import assert from "node:assert/strict";
import { test } from "node:test";
import { load, plainTheme, tui } from "./harness.mjs";

const { Container, Markdown, ScrollView, Spacer, TuiAltScreen, VStack, stripTerminalSequences } = tui;
const { default: register } = await load("src/index.ts");

const commands = {};
register({ registerCommand: (n, o) => (commands[n] = o), registerShortcut() {}, on() {} });

const theme = plainTheme;
const terminal = new Proxy({ columns: 40, rows: 30 }, { get: (t, k) => (k in t ? t[k] : () => {}) });

function setup(md) {
	const tui = new TuiAltScreen(terminal, false);
	tui.altScreenActive = true;
	const doc = new Container();
	const message = new Container();
	const content = new Container();
	message.addChild(content);
	content.addChild(new Spacer(1));
	content.addChild(new Markdown(md, 1, 0, theme));
	doc.addChild(message);
	const sv = new ScrollView(doc, { follow: "end", primary: true });
	tui.setLayoutRoot(new VStack([{ component: sv, basis: 0, grow: 1, shrink: 1, minSize: 1 }]));
	tui.doRender();
	const screen = () => tui.previousScreen.map(stripTerminalSequences);
	const mouse = (x, y, extra = {}) => tui.handleSelectionMouseEvent({ button: 0, x, y, release: false, ...extra });
	return { tui, screen, mouse, drag: (x0, y0, x1, y1) => {
		mouse(x0, y0);
		mouse(x1, y1, { button: 32 });
		mouse(x1, y1, { release: true });
		tui.doRender();
		return tui.getActiveSelectionText();
	} };
}

test("drag over a blockquote copies text without gutters or wraps", () => {
	const { screen, drag } = setup("> 今日は天気が良いので、公園まで散歩に行きました。帰りに本屋に寄って新しい小説を買いました。");
	const rows = screen().map((l, i) => [l, i]).filter(([l]) => l.includes("│"));
	const last = rows.at(-1);
	const text = drag(0, rows[0][1], 39, last[1]);
	assert.equal(text, "今日は天気が良いので、公園まで散歩に行きました。帰りに本屋に寄って新しい小説を買いました。", screen().join("\n"));
});

test("highlight skips the gutter", () => {
	const { tui, screen, drag } = setup("> quoted words here");
	const row = screen().findIndex((l) => l.includes("quoted"));
	drag(0, row, 30, row);
	const raw = tui.previousScreen[row];
	const highlighted = raw.slice(raw.indexOf("\x1b[7m"));
	assert.ok(stripTerminalSequences(highlighted).startsWith("quoted"), JSON.stringify(raw));
});

test("drag inside a table cell copies only that cell", () => {
	const { screen, drag } = setup("| k | value |\n|---|---|\n| a | one two three four five six seven |\n| b | x |");
	const s = screen();
	const r = s.findIndex((l) => l.includes("one"));
	const c = s[r].indexOf("one");
	const end = s.findIndex((l, i) => i > r && l.includes("├"));
	const text = drag(c, r, c + 3, end - 1);
	const parts = s.slice(r, end).map((l, i, all) => l.slice(c, i === all.length - 1 ? c + 4 : l.lastIndexOf("│")).trim());
	assert.equal(text, parts.join(" "), s.join("\n"));
	assert.ok(end - 1 > r && text.length < "one two three four five six seven".length);
});

test("triple click selects the whole logical line; quad click the block", () => {
	const { tui, screen, mouse } = setup("first paragraph that wraps over several rows of text\n\n- item one\n- item two");
	const r = screen().findIndex((l) => l.includes("first"));
	for (let i = 0; i < 3; i++) { mouse(3, r); mouse(3, r, { release: true }); }
	tui.doRender();
	assert.equal(tui.getActiveSelectionText(), "first paragraph that wraps over several rows of text");
	const li = screen().findIndex((l) => l.includes("item one"));
	tui.lastClick = undefined;
	for (let i = 0; i < 4; i++) { mouse(4, li); mouse(4, li, { release: true }); }
	tui.doRender();
	assert.equal(tui.getActiveSelectionText(), "- item one\n- item two");
});

test("alt-click copies block", async () => {
	const { tui, screen, mouse } = setup("para\n\n```js\nconst a = 1;\n```");
	let copied;
	tui.copyTextToClipboard = async (t) => { copied = t; return true; };
	const r = screen().findIndex((l) => l.includes("const"));
	mouse(4, r, { button: 8 });
	assert.equal(copied, "const a = 1;");
});

async function openMode(tui, name) {
	let component;
	let closed = false;
	const ctx = { hasUI: true, ui: { notify() {}, custom: async (factory) => { component = factory(tui, { fg: (_c, s) => s, bold: (s) => s }, {}, () => (closed = true)); } } };
	await commands[name].handler("", ctx);
	return { keys: (...ks) => ks.forEach((k) => component.handleInput(k)), closed: () => closed, component };
}

test("copy mode: V on a wrapped line then y copies the logical line", async () => {
	const { tui, screen } = setup("intro\n\n> quoted line that wraps across more than one row here\n\ntail");
	let copied;
	tui.copyTextToClipboard = async (t) => { copied = t; return true; };
	const mode = await openMode(tui, "copy-mode");
	const target = screen().findIndex((l) => l.includes("│"));
	const cursorRow = tui.__semanticCursor.row;
	mode.keys(...Array(cursorRow - target).fill("k"), "V", "y");
	assert.equal(copied, "quoted line that wraps across more than one row here");
	assert.ok(mode.closed());
	assert.equal(tui.__semanticCursor, undefined);
});

test("copy-block: starts on the last block, { moves up, Y copies markdown", async () => {
	const { tui } = setup("# Title\n\n**bold** para\n\n| a | b |\n|---|---|\n| 1 | 2 |");
	let copied;
	tui.copyTextToClipboard = async (t) => { copied = t; return true; };
	const mode = await openMode(tui, "copy-block");
	mode.keys("y");
	assert.equal(copied, "a\tb\n1\t2");
	const again = await openMode(tui, "copy-block");
	again.keys("{", "Y");
	assert.equal(copied, "**bold** para");
});

test("large message maps quickly", () => {
	const chunk = "## Section\n\nSome **bold** text with `code` and a [link](https://example.com/x) 日本語の文章も含めます。\n\n| col1 | col2 | col3 |\n|---|---|---|\n| a | b | c |\n| long cell text here | more | x |\n\n```ts\nconst x = 1;\n```\n\n- item\n  - nested\n\n> quote\n\n";
	const { tui, drag, screen } = setup(chunk.repeat(60));
	const t0 = performance.now();
	tui.handleSelectionMouseEvent({ button: 0, x: 0, y: 0, release: false });
	tui.handleSelectionMouseEvent({ button: 32, x: 39, y: 28, release: false });
	tui.handleSelectionMouseEvent({ button: 0, x: 39, y: 28, release: true });
	tui.doRender();
	const text = tui.getActiveSelectionText();
	const ms = performance.now() - t0;
	// Loose bound: catches a return to whole-message alignment (several seconds), not runner jitter.
	assert.ok(ms < 4000, `took ${ms}ms`);
	assert.ok(text && !text.includes("│") && !text.includes("─"), text);
});

test("patches apply to the Pi under test", async () => {
	let status;
	await commands["semantic-copy"].handler("", { ui: { notify: (m) => (status = m) } });
	assert.match(status, /^semantic copy: plain/, `internals changed: ${status}`);
});

test("blank lines inside a code block survive the copy", () => {
	const { tui, screen, mouse } = setup("```py\ndef a():\n    pass\n\n\ndef b():\n    pass\n```");
	const r = screen().findIndex((l) => l.includes("def a"));
	for (let i = 0; i < 4; i++) { mouse(4, r); mouse(4, r, { release: true }); }
	tui.doRender();
	assert.equal(tui.getActiveSelectionText(), "def a():\n    pass\n\n\ndef b():\n    pass");
});

test("copy mode claims PageUp/PageDown and cleans up when Pi disposes it", async () => {
	const { tui } = setup("one\n\ntwo");
	const mode = await openMode(tui, "copy-mode");
	assert.equal(mode.component.capturesViewportInput, true);
	mode.keys("v", "k");
	assert.ok(tui.__semanticCursor && tui.selectionAnchor);
	mode.component.dispose();
	assert.equal(tui.__semanticCursor, undefined);
	assert.equal(tui.selectionAnchor, undefined);
});

test("alt-click under an overlay does not copy the transcript", () => {
	const { tui, screen, mouse } = setup("para one\n\npara two");
	let copied;
	tui.copyTextToClipboard = async (t) => { copied = t; return true; };
	tui.hasOverlay = () => true;
	mouse(3, screen().findIndex((l) => l.includes("para two")), { button: 8 });
	assert.equal(copied, undefined);
});
