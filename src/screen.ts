// Bridge between TuiAltScreen's private layout/selection state and the pure source mapping in smap.ts.
import { Box, Markdown, sliceByColumn, stripTerminalSequences, Text, TuiAltScreen } from "@earendil-works/pi-tui";
import * as smap from "./smap.ts";

export type Mode = smap.CopyFormat | "off";
export interface Point {
	row: number;
	col: number;
	scrollView?: any;
	boundary?: boolean;
}
export interface Sel {
	start: Point;
	end: Point;
}
export interface Leaf {
	node: any;
	row0: number;
	rows: number;
	x0: number;
	width: number;
}

export const ORIGINALS = Symbol.for("semantic-copy/originals");
export const PATCHED = [
	"getActiveSelectionText",
	"applySelection",
	"getSelectionColumns",
	"getLineSelection",
	"getClickCount",
	"handleSelectionMouseEvent",
] as const;
const maps = new WeakMap<any, { lines: string[]; map: smap.LeafMap }>();

export function scrollBox(tui: any, scrollView: any, layout = tui.currentLayout): any {
	const visit = (box: any): any => {
		if (box.scrollView === scrollView) return box;
		for (const child of box.children ?? []) {
			const hit = visit(child);
			if (hit) return hit;
		}
	};
	return layout?.root ? visit(layout.root) : undefined;
}

function leavesOf(scrollView: any): Leaf[] {
	const out: Leaf[] = [];
	const walk = (node: any, row: number, x: number, width: number, height: number) => {
		if (node instanceof Markdown || node instanceof Text) {
			out.push({ node, row0: row, rows: height, x0: x, width });
			return;
		}
		const layout = node?.mouseLayout;
		if (!Array.isArray(layout?.children)) return;
		const box = node instanceof Box;
		let y = row + (box ? (node as any).paddingY : 0);
		for (const child of layout.children) {
			walk(child.component, y, x + (box ? (node as any).paddingX : 0), layout.width, child.height);
			y += child.height;
		}
	};
	const root = scrollView?.child;
	if (root?.mouseLayout) walk(root, 0, 0, root.mouseLayout.width, Number.MAX_SAFE_INTEGER);
	return out;
}

export const leafAt = (leaves: Leaf[], row: number) => leaves.find((l) => row >= l.row0 && row < l.row0 + l.rows);

export function mapOf(leaf: Leaf, content: string[]): smap.LeafMap | undefined {
	const lines: string[] = leaf.node.render(leaf.width);
	if (lines.length !== leaf.rows) return undefined;
	const cached = maps.get(leaf.node);
	if (cached?.lines === lines) return cached.map;
	// The leaf must be what is on screen at that offset, or every column would be off.
	const onScreen = stripTerminalSequences(sliceByColumn(content[leaf.row0] ?? "", leaf.x0, leaf.width, true)).trimEnd();
	if (onScreen !== stripTerminalSequences(lines[0] ?? "").trimEnd()) return undefined;
	// Markdown.text is private; it holds the source the component renders.
	const text: string = (leaf.node as any).text ?? "";
	const source = leaf.node instanceof Markdown ? text : stripTerminalSequences(text);
	const map = smap.buildMap(lines, source);
	maps.set(leaf.node, { lines, map });
	return map;
}

export interface Ctx {
	box: any;
	lines: string[];
	leaves: Leaf[];
}
export function contextOf(tui: any, scrollView: any, layout?: any): Ctx | undefined {
	const box = scrollBox(tui, scrollView, layout);
	if (!box?.scrollContentLines) return undefined;
	return { box, lines: box.scrollContentLines, leaves: leavesOf(scrollView) };
}

/** Selected leaf-local column ranges, per leaf, for a selection in scroll-content coordinates. */
export function leafRanges(tui: any, ctx: Ctx, sel: Sel, leaf: Leaf): smap.RowRanges {
	const ranges: smap.RowRanges = new Map();
	const from = Math.max(sel.start.row, leaf.row0);
	const to = Math.min(sel.end.row, leaf.row0 + leaf.rows - 1);
	for (let row = from; row <= to; row++) {
		const cols = original(tui, "getSelectionColumns")(ctx.lines[row] ?? "", row, sel);
		ranges.set(row - leaf.row0, [Math.max(0, cols.start - leaf.x0), Math.max(0, cols.end - leaf.x0)]);
	}
	return ranges;
}

export function semanticText(tui: any, sel: Sel, format: smap.CopyFormat): string | undefined {
	if (!sel.start.scrollView) return undefined;
	const ctx = contextOf(tui, sel.start.scrollView);
	if (!ctx) return undefined;
	const parts: string[] = [];
	for (let row = sel.start.row; row <= sel.end.row; ) {
		const leaf = leafAt(ctx.leaves, row);
		const map = leaf && mapOf(leaf, ctx.lines);
		if (leaf && map) {
			parts.push(smap.leafText(map, leafRanges(tui, ctx, sel, leaf), format));
			row = leaf.row0 + leaf.rows;
			continue;
		}
		const line = ctx.lines[row] ?? "";
		const cols = original(tui, "getSelectionColumns")(line, row, sel);
		const text = stripTerminalSequences(sliceByColumn(line, cols.start, Math.max(0, cols.end - cols.start), true)).trimEnd();
		// Spacer rows between messages collapse to one blank line; blank lines inside a leaf are content.
		if (text || parts.at(-1) !== "") parts.push(text);
		row++;
	}
	return parts.join("\n").replace(/^\n+|\s+$/g, "");
}

function original(tui: any, name: (typeof PATCHED)[number]) {
	const fn = (TuiAltScreen.prototype as any)[ORIGINALS][name];
	return (...args: any[]) => fn.apply(tui, args);
}

/** Range of the logical line or block through a content point. */
export function unitRange(tui: any, point: Point, unit: "line" | "block"): Sel | undefined {
	const ctx = contextOf(tui, point.scrollView);
	const leaf = ctx && leafAt(ctx.leaves, point.row);
	const map = leaf && mapOf(leaf, ctx.lines);
	if (!leaf || !map) return undefined;
	const at = (row: number, col: number, boundary = false): Point => ({
		...point,
		row: row + leaf.row0,
		col: col + leaf.x0,
		boundary,
	});
	if (unit === "line") {
		const line = smap.logicalLine(map, point.row - leaf.row0, point.col - leaf.x0);
		return line && { start: at(line.r0, line.c0), end: at(line.r1, line.c1, true) };
	}
	const block = smap.blockAt(map, point.row - leaf.row0);
	if (!block) return undefined;
	const first = smap.rowCells(map, block.r0).find((c) => !c.ws && !c.deco);
	return { start: at(block.r0, first?.col ?? 0), end: at(block.r1, smap.rowEnd(map, block.r1), true) };
}

export function applyRange(tui: any, range: Sel, granularity: string) {
	tui.selectionGranularity = granularity;
	tui.selectionInitialRange = range;
	tui.selectionAnchor = range.start;
	tui.selectionFocus = range.end;
	tui.pressedUrl = undefined;
}
