// Keyboard copy mode: a vim-like cursor over the transcript that copies through the same source mapping.
import { decodeKittyPrintable, isKeyRelease, matchesKey, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type * as smap from "./smap.ts";
import { contextOf, mapOf, type Point, type Sel, scrollBox, semanticText, unitRange } from "./screen.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });

function rowCells(line: string) {
	const cells: { col: number; w: number; ch: string }[] = [];
	let col = 0;
	for (const { segment } of graphemes.segment(stripTerminalSequences(line))) {
		const w = visibleWidth(segment);
		if (w <= 0) continue;
		cells.push({ col, w, ch: segment });
		col += w;
	}
	return cells;
}

function wordStarts(line: string): number[] {
	const text = stripTerminalSequences(line);
	const starts: number[] = [];
	let col = 0;
	for (const seg of words.segment(text)) {
		if (seg.isWordLike || /^[^\s\p{L}\p{N}]+$/u.test(seg.segment.trim()) && seg.segment.trim()) starts.push(col);
		col += visibleWidth(seg.segment);
	}
	return starts;
}

type Unit = "char" | "line" | "block";

export class CopyMode {
	private cursor: Point;
	private anchor?: Point;
	private unit: Unit = "char";
	private goalCol = 0;
	private message = "";
	/** /copy-block: j/k and { } step one whole block, and the selection follows the cursor. */
	private picker: boolean;

	constructor(
		private tui: any,
		private theme: any,
		private done: () => void,
		blockMode: boolean,
	) {
		this.picker = blockMode;
		const scrollView = tui.getPrimaryScrollView();
		const ctx = contextOf(tui, scrollView);
		const last = Math.min((ctx?.lines.length ?? 1) - 1, scrollView.scrollTop + scrollView.viewportHeight - 1);
		let row = Math.max(0, last);
		while (row > scrollView.scrollTop && !stripTerminalSequences(ctx?.lines[row] ?? "").trim()) row--;
		this.cursor = { row, col: 0, scrollView };
		this.cursor.col = this.firstCol(row);
		if (blockMode) {
			const block = this.findBlock(row, -1, true);
			if (block) this.cursor = { ...this.cursor, row: block.start.row, col: block.start.col, boundary: false };
			this.anchor = { ...this.cursor };
			this.unit = "block";
		}
		this.goalCol = this.cursor.col;
		this.sync();
	}

	private lines(): string[] {
		return scrollBox(this.tui, this.cursor.scrollView)?.scrollContentLines ?? [];
	}

	private firstCol(row: number): number {
		const cell = rowCells(this.lines()[row] ?? "").find((c) => c.ch.trim() && c.ch !== "│");
		return cell?.col ?? 0;
	}

	private lastCol(row: number): number {
		const cells = rowCells(this.lines()[row] ?? "").filter((c) => c.ch.trim());
		return cells.at(-1)?.col ?? 0;
	}

	private snap(row: number, col: number): number {
		const cells = rowCells(this.lines()[row] ?? "");
		const end = this.lastCol(row);
		const target = Math.min(col, end);
		return cells.find((c) => target >= c.col && target < c.col + c.w)?.col ?? 0;
	}

	private moveTo(row: number, col: number, keepGoal = false) {
		const max = Math.max(0, this.lines().length - 1);
		row = Math.max(0, Math.min(max, row));
		this.cursor = { ...this.cursor, row, col: this.snap(row, Math.max(0, col)) };
		if (!keepGoal) this.goalCol = this.cursor.col;
	}

	/** The block containing the row, else the nearest block starting after (dir 1) or before (dir -1) it. */
	private findBlock(row: number, dir: 1 | -1, containing = false): Sel | undefined {
		const ctx = contextOf(this.tui, this.cursor.scrollView);
		if (!ctx) return undefined;
		const leaves = dir > 0 ? ctx.leaves : [...ctx.leaves].reverse();
		for (const leaf of leaves) {
			if (dir > 0 ? leaf.row0 + leaf.rows <= row : leaf.row0 > row) continue;
			const map = mapOf(leaf, ctx.lines);
			if (!map) continue;
			const blocks = dir > 0 ? map.blocks : [...map.blocks].reverse();
			const hit = blocks.find((b) => {
				const r0 = b.r0 + leaf.row0;
				const r1 = b.r1 + leaf.row0;
				if (containing && row >= r0 && row <= r1) return true;
				return dir > 0 ? r0 > row : r0 < row && !(row >= r0 && row <= r1);
			});
			if (hit) return unitRange(this.tui, { ...this.cursor, row: hit.r0 + leaf.row0 }, "block");
		}
		return undefined;
	}

	private selection(): Sel | undefined {
		if (!this.anchor) return undefined;
		const range = (p: Point): Sel => {
			if (this.unit !== "char") {
				const r = unitRange(this.tui, p, this.unit);
				if (r) return r;
				const end = rowCells(this.lines()[p.row] ?? "").filter((c) => c.ch.trim()).at(-1);
				return {
					start: { ...p, col: this.firstCol(p.row), boundary: false },
					end: { ...p, col: end ? end.col + end.w : 0, boundary: true },
				};
			}
			return { start: p, end: p };
		};
		const a = range(this.anchor);
		const c = range(this.cursor);
		const before = (x: Point, y: Point) => x.row < y.row || (x.row === y.row && x.col < y.col);
		const start = before(c.start, a.start) ? c.start : a.start;
		let end = before(a.end, c.end) ? c.end : a.end;
		if (!end.boundary && start.row === end.row && start.col === end.col) {
			const cell = rowCells(this.lines()[end.row] ?? "").find((x) => x.col === end.col);
			end = { ...end, col: end.col + (cell?.w ?? 1), boundary: true };
		}
		return { start, end };
	}

	private sync() {
		const tui = this.tui;
		const sv = this.cursor.scrollView;
		if (this.cursor.row < sv.scrollTop) tui.scrollBy(this.cursor.row - sv.scrollTop);
		else if (this.cursor.row >= sv.scrollTop + sv.viewportHeight) tui.scrollBy(this.cursor.row - sv.scrollTop - sv.viewportHeight + 1);
		tui.__semanticCursor = this.cursor;
		const sel = this.selection();
		tui.clearTextSelection();
		if (sel) {
			tui.selectionAnchor = sel.start;
			tui.selectionFocus = sel.end;
		}
		tui.requestRender();
	}

	private copy(format: smap.CopyFormat) {
		const sel = this.selection() ?? unitRange(this.tui, this.cursor, "block");
		if (!sel) {
			this.message = "nothing to copy";
			return;
		}
		const text = semanticText(this.tui, sel, format);
		if (!text) {
			this.message = "nothing to copy";
			return;
		}
		void this.tui.copyTextToClipboard(text);
		this.close();
	}

	private close() {
		this.tui.__semanticCursor = undefined;
		this.tui.clearTextSelection();
		this.tui.requestRender();
		this.done();
	}

	private toggle(unit: Unit) {
		if (this.anchor && this.unit === unit) this.anchor = undefined;
		else {
			this.anchor ??= { ...this.cursor };
			this.unit = unit;
		}
	}

	handleInput(data: string) {
		if (isKeyRelease(data)) return;
		const key = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " ? data : undefined);
		const sv = this.cursor.scrollView;
		const half = Math.max(1, Math.floor(sv.viewportHeight / 2));
		const { row, col } = this.cursor;
		this.message = "";
		if (this.picker) {
			const down = key === "j" || key === "}" || matchesKey(data, "down");
			const up = key === "k" || key === "{" || matchesKey(data, "up");
			if (down || up) {
				const block = this.findBlock(row, down ? 1 : -1);
				if (block) this.moveTo(block.start.row, block.start.col);
				this.anchor = { ...this.cursor };
				return this.sync();
			}
			if (key === "v" || key === "V") this.picker = false;
		}
		if (matchesKey(data, "escape")) {
			if (this.anchor) this.anchor = undefined;
			else return this.close();
		} else if (key === "q") return this.close();
		else if (key === "h" || matchesKey(data, "left")) {
			const prev = rowCells(this.lines()[row] ?? "").filter((c) => c.col < col).at(-1);
			this.moveTo(row, prev?.col ?? col);
		} else if (key === "l" || matchesKey(data, "right")) {
			const next = rowCells(this.lines()[row] ?? "").find((c) => c.col > col);
			if (next && next.col <= this.lastCol(row)) this.moveTo(row, next.col);
		} else if (key === "j" || matchesKey(data, "down")) this.moveTo(row + 1, this.goalCol, true);
		else if (key === "k" || matchesKey(data, "up")) this.moveTo(row - 1, this.goalCol, true);
		else if (key === "0") this.moveTo(row, 0);
		else if (key === "^") this.moveTo(row, this.firstCol(row));
		else if (key === "$") this.moveTo(row, this.lastCol(row));
		else if (key === "w") {
			let r = row;
			let next = wordStarts(this.lines()[r] ?? "").find((c) => c > col);
			while (next === undefined && r + 1 < this.lines().length) next = wordStarts(this.lines()[++r] ?? "")[0];
			this.moveTo(r, next ?? col);
		} else if (key === "b") {
			let r = row;
			let prev = wordStarts(this.lines()[r] ?? "").filter((c) => c < col).at(-1);
			while (prev === undefined && r > 0) prev = wordStarts(this.lines()[--r] ?? "").at(-1);
			this.moveTo(r, prev ?? col);
		} else if (key === "g" || matchesKey(data, "home")) this.moveTo(0, 0);
		else if (key === "G" || matchesKey(data, "end")) this.moveTo(this.lines().length - 1, 0);
		else if (matchesKey(data, "ctrl+u")) this.moveTo(row - half, this.goalCol, true);
		else if (matchesKey(data, "ctrl+d")) this.moveTo(row + half, this.goalCol, true);
		else if (matchesKey(data, "ctrl+b") || matchesKey(data, "pageUp")) this.moveTo(row - sv.viewportHeight + 2, this.goalCol, true);
		else if (matchesKey(data, "ctrl+f") || matchesKey(data, "pageDown")) this.moveTo(row + sv.viewportHeight - 2, this.goalCol, true);
		else if (key === "{" || key === "}") {
			const block = this.findBlock(row, key === "}" ? 1 : -1);
			if (block) this.moveTo(block.start.row, block.start.col);
		} else if (key === "v") this.toggle("char");
		else if (key === "V") this.toggle("line");
		else if (key === "B" || key === "a") this.toggle("block");
		else if (key === "o" && this.anchor) [this.anchor, this.cursor] = [{ ...this.cursor }, { ...this.anchor }];
		else if (key === "y" || matchesKey(data, "enter")) return this.copy("plain");
		else if (key === "Y" || key === "m") return this.copy("markdown");
		else return;
		this.sync();
	}

	render(width: number): string[] {
		const t = this.theme;
		const label = this.picker ? "BLOCK PICK" : this.anchor ? { char: "VISUAL", line: "V-LINE", block: "BLOCK" }[this.unit] : "COPY";
		const hint = this.message
			? t.fg("warning", this.message)
			: t.fg(
					"dim",
					this.picker
						? "j/k or {} pick block · y/enter copy · Y markdown · v/V free select · esc/q quit"
						: "hjkl/w/b move · {} block · v/V/B select · o swap · y copy · Y markdown · esc/q quit",
				);
		const line = `${t.fg("accent", t.bold(` ${label} `))} ${t.fg("muted", `${this.cursor.row + 1}:${this.cursor.col + 1}`)}  ${hint}`;
		return [sliceByColumn(line, 0, width, true)];
	}

	invalidate() {}
}
