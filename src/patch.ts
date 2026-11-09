// Patches TuiAltScreen's selection methods; every patch falls back to the original on failure.
import { sliceByColumn, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import * as smap from "./smap.ts";
import {
	applyRange,
	contextOf,
	leafAt,
	leafRanges,
	mapOf,
	type Mode,
	ORIGINALS,
	PATCHED,
	type Point,
	type Sel,
	scrollBox,
	semanticText,
	unitRange,
} from "./screen.ts";

export const settings: { mode: Mode } = { mode: "plain" };

export function install(): string | undefined {
	const proto = TuiAltScreen.prototype as any;
	const missing = [
		...PATCHED,
		"getSelectionBounds",
		"getPrimaryScrollView",
		"getScrollSelectionPoint",
		"copyTextToClipboard",
		"clearTextSelection",
		"hasOverlay",
	].filter(
		(name) => typeof (proto[ORIGINALS]?.[name] ?? proto[name]) !== "function",
	);
	if (missing.length) return `semantic-copy disabled: Pi internals changed (${missing.join(", ")})`;
	const originals = (proto[ORIGINALS] ??= Object.fromEntries(PATCHED.map((name) => [name, proto[name]])));
	const guard =
		(name: (typeof PATCHED)[number], patched: (this: any, ...args: any[]) => any) =>
		function (this: any, ...args: any[]) {
			if (settings.mode !== "off") {
				try {
					const result = patched.apply(this, args);
					if (result !== undefined) return result;
				} catch {}
			}
			return originals[name].apply(this, args);
		};

	proto.getActiveSelectionText = guard("getActiveSelectionText", function () {
		const sel = this.getSelectionBounds();
		return sel ? semanticText(this, sel, settings.mode as smap.CopyFormat) || undefined : undefined;
	});

	proto.applySelection = function (this: any, screen: string[], layout = this.currentLayout) {
		try {
			screen = paintCursor(this, screen, layout);
			const sel: Sel | undefined = settings.mode === "off" ? undefined : this.getSelectionBounds();
			const ctx = sel?.start.scrollView ? contextOf(this, sel.start.scrollView, layout) : undefined;
			this.__semanticCopy = ctx && { ...ctx, sel, ranges: new Map() };
			return originals.applySelection.call(this, screen, layout);
		} catch {
			return originals.applySelection.call(this, screen, layout);
		} finally {
			this.__semanticCopy = undefined;
		}
	};

	// Inside applySelection only: narrow each row's highlight to the cells the copy will contain.
	proto.getSelectionColumns = guard("getSelectionColumns", function (line, row, _selection, minColumn = 0, maxColumn) {
		const ctx = this.__semanticCopy;
		if (!ctx) return undefined;
		const dy = ctx.box.rect.y - ctx.sel.start.scrollView.scrollTop;
		const dx = ctx.box.rect.x;
		const leaf = leafAt(ctx.leaves, row - dy);
		const map = leaf && mapOf(leaf, ctx.lines);
		if (!leaf || !map) return undefined;
		if (!ctx.ranges.has(leaf)) ctx.ranges.set(leaf, leafRanges(this, ctx, ctx.sel, leaf));
		const range = smap.highlightRange(map, ctx.ranges.get(leaf), row - dy - leaf.row0);
		const max = maxColumn ?? visibleWidth(line);
		if (!range) return { start: minColumn, end: minColumn };
		return { start: Math.max(minColumn, range[0] + leaf.x0 + dx), end: Math.min(max, range[1] + leaf.x0 + dx) };
	});

	proto.getLineSelection = guard("getLineSelection", function (point: Point) {
		return point.scrollView ? unitRange(this, point, this.__semanticBlock ? "block" : "line") : undefined;
	});

	// A fourth click selects the whole Markdown block (paragraph, list, table, code block, quote).
	proto.getClickCount = function (this: any, point: Point, word: any) {
		const previous = this.lastClick;
		const count = originals.getClickCount.call(this, point, word);
		if (settings.mode === "off") return count;
		try {
			const repeated =
				previous &&
				this.lastClick &&
				this.lastClick.timestamp - previous.timestamp <= 500 &&
				previous.row === this.lastClick.row &&
				previous.scrollView === this.lastClick.scrollView;
			if (count === 1 && repeated && previous.count === 3) this.lastClick.count = 4;
			else if (count === 2 && previous?.count === 4) this.lastClick.count = 1;
			return this.lastClick?.count ?? count;
		} catch {
			return count;
		}
	};

	proto.handleSelectionMouseEvent = function (this: any, event: any) {
		const press = !event.release && (event.button & 32) === 0 && (event.button & 3) === 0;
		if (press) this.__semanticBlock = false;
		if (press && settings.mode !== "off" && (event.button & 8) !== 0 && !this.hasOverlay()) {
			// Alt+click: select and copy the block under the pointer.
			try {
				const scrollView = this.getPrimaryScrollView();
				const rect = scrollBox(this, scrollView)?.rect;
				const inside =
					rect &&
					event.y >= rect.y &&
					event.y < rect.y + rect.height &&
					event.x >= rect.x &&
					event.x < rect.x + rect.width;
				const point = inside ? this.getScrollSelectionPoint(scrollView, event.x, event.y) : undefined;
				const range = point && unitRange(this, point, "block");
				if (range) {
					this.clearTextSelection();
					applyRange(this, range, "character");
					const text = semanticText(this, range, settings.mode as smap.CopyFormat);
					if (text) void this.copyTextToClipboard(text);
					this.requestRender();
					return;
				}
			} catch {}
		}
		originals.handleSelectionMouseEvent.call(this, event);
		if (!press || settings.mode === "off" || this.lastClick?.count !== 4 || !this.selectionAnchor?.scrollView) return;
		try {
			const range = unitRange(this, this.selectionAnchor, "block");
			if (!range) return;
			applyRange(this, range, "line");
			this.__semanticBlock = true;
			this.requestRender();
		} catch {}
	};
	return undefined;
}

function paintCursor(tui: any, screen: string[], layout: any): string[] {
	const cursor = tui.__semanticCursor as Point | undefined;
	if (!cursor?.scrollView) return screen;
	const box = scrollBox(tui, cursor.scrollView, layout);
	if (!box) return screen;
	const row = box.rect.y + cursor.row - cursor.scrollView.scrollTop;
	if (row < box.rect.y || row >= box.rect.y + box.rect.height || row >= screen.length) return screen;
	const line = screen[row];
	const col = box.rect.x + cursor.col;
	const cell = sliceByColumn(line, col, 1, true) || " ";
	const width = Math.max(1, visibleWidth(cell));
	const out = [...screen];
	out[row] =
		sliceByColumn(line, 0, col, true) +
		`\x1b[4;7m${cell}\x1b[24;27m` +
		sliceByColumn(line, col + width, Math.max(0, visibleWidth(line) - col - width), true);
	return out;
}
