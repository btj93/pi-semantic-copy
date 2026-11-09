import assert from "node:assert/strict";
import { test } from "node:test";
import { load, plainTheme, tui } from "./harness.mjs";

const { Markdown, Text } = tui;
const smap = await load("src/smap.ts");

const theme = plainTheme;
const render = (md, width) => {
	const lines = new Markdown(md, 1, 0, theme).render(width);
	return { lines, map: smap.buildMap(lines, md) };
};
const all = (map) => smap.fullRows(0, map.rows.length - 1);
const show = (lines) => lines.map((l) => `|${l}|`).join("\n");

test("myers align", () => {
	const m = smap.align([..."abXcd"], [..."a*b*cYd"]);
	assert.deepEqual([...m], [0, 2, -1, 4, 6]);
});

test("blockquote copies without gutter and joins CJK soft wraps", () => {
	const md = "はじめに\n\n> こんにちは\n> 今日は天気が良いので、公園まで散歩に行きました。帰りに本屋に寄って新しい小説を買いました。\n\nおわりに";
	const { lines, map } = render(md, 30);
	const quoteRows = lines.map((l, i) => [l, i]).filter(([l]) => l.includes("│")).map(([, i]) => i);
	const text = smap.leafText(map, smap.fullRows(quoteRows[0], quoteRows.at(-1)), "plain");
	assert.equal(text, "こんにちは\n今日は天気が良いので、公園まで散歩に行きました。帰りに本屋に寄って新しい小説を買いました。", show(lines));
	assert.equal(smap.leafText(map, smap.fullRows(quoteRows[0], quoteRows.at(-1)), "markdown"),
		"> こんにちは\n> 今日は天気が良いので、公園まで散歩に行きました。帰りに本屋に寄って新しい小説を買いました。");
});

test("english soft wraps join with a space; paragraphs keep blank line", () => {
	const md = "The quick brown fox jumps over the lazy dog and keeps running far away.\n\nSecond **bold** paragraph.";
	const { lines, map } = render(md, 24);
	assert.equal(smap.leafText(map, all(map), "plain"),
		"The quick brown fox jumps over the lazy dog and keeps running far away.\n\nSecond bold paragraph.", show(lines));
});

test("table: one cell, a row, and whole table", () => {
	const md = "| Name | Notes |\n|---|---|\n| alpha | a long note that will wrap across lines |\n| beta | short |";
	const { lines, map } = render(md, 34);
	const r = lines.findIndex((l) => l.includes("alpha"));
	const col = lines[r].indexOf("a long");
	const cell = smap.leafText(map, new Map([[r, [col, 999]], [r + 1, [0, 999]], [r + 2, [0, col + 3]]]), "plain");
	assert.equal(cell, "a long note that will wrap across lines".slice(0, cell.length), show(lines));
	assert.ok(cell.startsWith("a long note that"), cell);
	const line = smap.logicalLine(map, r + 1, col + 1);
	const fullCell = smap.leafText(map, new Map([[line.r0, [line.c0, 999]], ...Array.from({ length: line.r1 - line.r0 - 1 }, (_, i) => [line.r0 + 1 + i, [0, 999]]), [line.r1, [0, line.c1]]]), "plain");
	assert.equal(fullCell, "a long note that will wrap across lines");
	assert.equal(smap.leafText(map, all(map), "plain"), "Name\tNotes\nalpha\ta long note that will wrap across lines\nbeta\tshort");
});

test("code block: plain drops fences, keeps indentation", () => {
	const md = "Run:\n\n```sh\nif true; then\n    echo hi\nfi\n```\n";
	const { lines, map } = render(md, 40);
	const block = map.blocks.find((b) => b.type === "code");
	assert.equal(smap.leafText(map, smap.fullRows(block.r0, block.r1), "plain"), "if true; then\n    echo hi\nfi", show(lines));
	assert.equal(smap.leafText(map, smap.fullRows(block.r0, block.r1), "markdown"), "```sh\nif true; then\n    echo hi\nfi\n```");
});

test("lists keep markers and nesting; wraps join", () => {
	const md = "* first item that is long enough to wrap\n* second\n  * nested child";
	const { lines, map } = render(md, 24);
	assert.equal(smap.leafText(map, all(map), "plain"), "- first item that is long enough to wrap\n- second\n  - nested child", show(lines));
});

test("highlight excludes quote gutter", () => {
	const md = "> quoted text";
	const { lines, map } = render(md, 30);
	const range = smap.highlightRange(map, all(map), 0);
	assert.equal(lines[0].slice(range[0], range[1]), "quoted text");
});

test("plain Text leaf joins wraps", () => {
	const text = new Text("alpha beta gamma delta epsilon", 1, 0);
	const lines = text.render(14);
	const map = smap.buildMap(lines, "alpha beta gamma delta epsilon");
	assert.equal(smap.leafText(map, all(map), "plain"), "alpha beta gamma delta epsilon");
});
