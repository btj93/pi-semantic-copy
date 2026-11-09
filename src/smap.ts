// Maps rendered Markdown/Text rows back to their source text so copies drop terminal decoration
// (quote gutters, table borders, code fences, padding) and rejoin soft wraps.
import { Marked, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

export type CopyFormat = "plain" | "markdown";

export interface Cell {
	ch: string;
	col: number;
	w: number;
	ws: boolean;
	deco: boolean;
	src: number;
	srcEnd: number;
}

export interface TableRef {
	tid: number;
	lrow: number;
	col: number;
}

export interface Seg {
	row: number;
	start: number;
	end: number;
	table?: TableRef;
}

export interface Block {
	r0: number;
	r1: number;
	start: number;
	end: number;
	type: string;
}

export interface LeafMap {
	source: string;
	rows: Cell[][];
	segs: Seg[];
	rowSegs: number[][];
	fence: boolean[];
	blocks: Block[];
}

/** Selected leaf-local column range [start, end) per row. */
export type RowRanges = Map<number, [number, number]>;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const BOX = new Set("│─┼├┤┌┐└┘┬┴╭╮╰╯━┃");
const MAX_EDITS = 1500;

export function toCells(line: string): Cell[] {
	const cells: Cell[] = [];
	let col = 0;
	const text = stripTerminalSequences(line);
	const parts = /^[\x20-\x7e]*$/.test(text) ? text : Array.from(graphemes.segment(text), (g) => g.segment);
	for (const segment of parts) {
		const w = segment.length === 1 && segment < "\x7f" ? 1 : visibleWidth(segment);
		if (w <= 0) continue;
		cells.push({ ch: segment, col, w, ws: /^\s+$/.test(segment), deco: false, src: -1, srcEnd: -1 });
		col += w;
	}
	return cells;
}

const cellAt = (row: Cell[], col: number) => row.find((c) => c.col <= col && col < c.col + c.w);

/**
 * Aligns every rendered grapheme (a) to the source (b) in order: Myers diff in overlapping windows, so the cost stays
 * near-linear for long messages. Returns, for each a[i], the matched index in b or -1.
 */
export function align(a: string[], b: string[]): Int32Array {
	const out = new Int32Array(a.length).fill(-1);
	const window = 1200;
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const aEnd = Math.min(a.length, i + window);
		const local = alignWindow(a.slice(i, aEnd), b.slice(j, Math.min(b.length, j + 2 * window)));
		const last = aEnd === a.length;
		const keep = last ? local.length : window / 2;
		let next = -1;
		for (let k = 0; k < keep && k < local.length; k++) {
			if (local[k] < 0) continue;
			out[i + k] = j + local[k];
			next = k;
		}
		if (last) break;
		if (next < 0) {
			i += window / 2;
			continue;
		}
		j = out[i + next] + 1;
		i += next + 1;
	}
	return out;
}

/** Myers alignment of all of a against a prefix of b (unmatched b after the last match is free). */
function alignWindow(a: string[], b: string[]): Int32Array {
	const out = new Int32Array(a.length).fill(-1);
	const n = a.length;
	const m = b.length;
	if (!n || !m) return out;
	const max = n + m;
	const off = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let endX = -1;
	let endY = -1;
	for (let d = 0; d <= max && endX < 0; d++) {
		if (d > MAX_EDITS) return greedy(a, b, out, 0, n, 0, m);
		trace.push(v.slice(off - d - 1, off + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
			let y = x - k;
			if (y > m) continue;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= n) {
				endX = x;
				endY = y;
				break;
			}
		}
	}
	let x = endX;
	let y = endY;
	for (let d = trace.length - 1; d >= 0; d--) {
		const t = trace[d];
		const at = (k: number) => t[k + d + 1];
		const k = x - y;
		const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const px = d === 0 ? 0 : at(pk);
		const py = d === 0 ? 0 : px - pk;
		while (x > px && y > py) out[--x] = --y;
		x = px;
		y = py;
	}
	return out;
}

function greedy(a: string[], b: string[], out: Int32Array, a0: number, a1: number, b0: number, b1: number) {
	let j = b0;
	for (let i = a0; i < a1; i++) {
		for (let t = j; t < Math.min(b1, j + 200); t++) {
			if (a[i] !== b[t]) continue;
			out[i] = t;
			j = t + 1;
			break;
		}
	}
	return out;
}

function tableTop(row: Cell[]): number[] | undefined {
	const first = row.findIndex((c) => c.ch === "┌");
	if (first < 0 || row[first + 1]?.ch !== "─") return undefined;
	const bounds = [row[first].col];
	for (let i = first + 1; i < row.length; i++) {
		if (row[i].ch === "┬" || row[i].ch === "┐") bounds.push(row[i].col);
		if (row[i].ch === "┐") return bounds.length >= 2 ? bounds : undefined;
	}
	return undefined;
}

export function buildMap(lines: string[], source: string): LeafMap {
	const rows = lines.map(toCells);
	const segs: Seg[] = [];
	const forced = rows.map((r) => new Array<boolean>(r.length).fill(false));
	const fence = rows.map(() => false);
	let tid = 0;
	for (let i = 0; i < rows.length; ) {
		const bounds = tableTop(rows[i]);
		if (!bounds) {
			segs.push({ row: i, start: 0, end: Number.MAX_SAFE_INTEGER });
			i++;
			continue;
		}
		tid++;
		const left = bounds[0];
		const boundSet = new Set(bounds);
		forced[i].fill(true);
		let lrow = 0;
		let group: number[] = [];
		const flush = () => {
			for (let col = 0; col + 1 < bounds.length; col++) {
				for (const row of group) {
					segs.push({ row, start: bounds[col] + 2, end: bounds[col + 1] - 1, table: { tid, lrow, col } });
				}
			}
			if (group.length) lrow++;
			group = [];
		};
		let j = i + 1;
		for (; j < rows.length; j++) {
			const ch = cellAt(rows[j], left)?.ch;
			if (ch === "│") {
				group.push(j);
				rows[j].forEach((c, k) => {
					if (c.col <= left || boundSet.has(c.col)) forced[j][k] ||= c.ch === "│";
				});
				continue;
			}
			if (ch !== "├" && ch !== "└") break;
			flush();
			forced[j].fill(true);
			if (ch === "└") {
				j++;
				break;
			}
		}
		flush();
		i = j;
	}
	// Leading blockquote gutters, and code fence rows the renderer draws for every code block.
	rows.forEach((row, r) => {
		let k = 0;
		while (k < row.length && (row[k].ws || row[k].ch === "│")) {
			if (row[k].ch === "│") forced[r][k] = true;
			k++;
		}
		const rest = row
			.slice(k)
			.map((c) => c.ch)
			.join("")
			.trimEnd();
		fence[r] = /^```[^\s`]*$/.test(rest);
	});

	const srcChars: string[] = [];
	const srcPos: number[] = [];
	let pos = 0;
	for (const { segment } of graphemes.segment(source)) {
		if (!/^\s+$/.test(segment)) {
			srcChars.push(segment);
			srcPos.push(pos);
		}
		pos += segment.length;
	}
	const inSource = new Set(srcChars);
	const stream: Cell[] = [];
	const rowSegs: number[][] = rows.map(() => []);
	segs.forEach((seg, index) => {
		rowSegs[seg.row].push(index);
		rows[seg.row].forEach((c, k) => {
			if (c.col < seg.start || c.col >= seg.end || c.ws || forced[seg.row][k]) return;
			if (BOX.has(c.ch) && !inSource.has(c.ch)) return;
			stream.push(c);
		});
	});
	const matched = align(
		stream.map((c) => c.ch),
		srcChars,
	);
	stream.forEach((c, i) => {
		const j = matched[i];
		if (j < 0) return;
		c.src = srcPos[j];
		c.srcEnd = srcPos[j] + srcChars[j].length;
	});
	rows.forEach((row, r) =>
		row.forEach((c, k) => {
			c.deco = forced[r][k] || (BOX.has(c.ch) && c.src < 0);
		}),
	);
	const map: LeafMap = { source, rows, segs, rowSegs, fence, blocks: [] };
	map.blocks = findBlocks(map);
	return map;
}

const isBlank = (row: Cell[]) => row.every((c) => c.ws);
const hasMapped = (row: Cell[]) => row.some((c) => c.src >= 0);

function findBlocks(map: LeafMap): Block[] {
	const { rows, source } = map;
	const blocks: Block[] = [];
	let tokens: { raw: string; type: string }[] = [];
	try {
		tokens = new Marked().lexer(source) as any;
	} catch {}
	if (tokens.reduce((n, t) => n + t.raw.length, 0) === source.length && source.length > 0) {
		const starts: number[] = [];
		let offset = 0;
		for (const token of tokens) {
			starts.push(offset);
			offset += token.raw.length;
		}
		const span = tokens.map(() => [-1, -1]);
		rows.forEach((row, r) => {
			for (const c of row) {
				if (c.src < 0) continue;
				let lo = 0;
				let hi = starts.length - 1;
				while (lo < hi) {
					const mid = (lo + hi + 1) >> 1;
					if (starts[mid] <= c.src) lo = mid;
					else hi = mid - 1;
				}
				if (span[lo][0] < 0) span[lo][0] = r;
				span[lo][1] = r;
			}
		});
		tokens.forEach((token, t) => {
			let [r0, r1] = span[t];
			if (token.type === "space" || !token.raw.trim() || r0 < 0) return;
			while (r0 > 0 && !isBlank(rows[r0 - 1]) && !hasMapped(rows[r0 - 1])) r0--;
			while (r1 + 1 < rows.length && !isBlank(rows[r1 + 1]) && !hasMapped(rows[r1 + 1])) r1++;
			blocks.push({ r0, r1, start: starts[t], end: starts[t] + token.raw.length, type: token.type });
		});
		if (blocks.length) return blocks;
	}
	// Plain text (or a lexer mismatch): blank rows separate blocks.
	let r0 = -1;
	rows.forEach((row, r) => {
		const blank = isBlank(row);
		if (!blank && r0 < 0) r0 = r;
		if ((blank || r === rows.length - 1) && r0 >= 0) {
			const r1 = blank ? r - 1 : r;
			const span = rows.slice(r0, r1 + 1).flat().filter((c) => c.src >= 0);
			const start = span.length ? Math.min(...span.map((c) => c.src)) : 0;
			const end = span.length ? Math.max(...span.map((c) => c.srcEnd)) : 0;
			blocks.push({ r0, r1, start, end, type: "text" });
			r0 = -1;
		}
	});
	return blocks;
}

const segCells = (map: LeafMap, seg: Seg, a = seg.start, b = seg.end) =>
	map.rows[seg.row].filter((c) => c.col >= Math.max(a, seg.start) && c.col < Math.min(b, seg.end) && !c.deco);
const contentCells = (cells: Cell[]) => {
	const first = cells.findIndex((c) => !c.ws);
	let last = cells.length - 1;
	while (last >= 0 && cells[last].ws) last--;
	return first < 0 ? [] : cells.slice(first, last + 1);
};

/** Source text between two segments when the second continues the first's line, or undefined for a hard break. */
function softJoin(map: LeafMap, prev: Seg, next: Seg): string | undefined {
	if (map.fence[prev.row] || map.fence[next.row]) return undefined;
	const a = segCells(map, prev).filter((c) => c.src >= 0).at(-1);
	const b = segCells(map, next).find((c) => c.src >= 0);
	if (!a || !b || b.src < a.srcEnd) return undefined;
	const gap = map.source.slice(a.srcEnd, b.src);
	return gap.includes("\n") ? undefined : gap.replace(/\S+/g, "");
}

function indentOf(map: LeafMap, seg: Seg): string {
	const first = segCells(map, seg).find((c) => c.src >= 0);
	if (!first) return "";
	const lineStart = map.source.lastIndexOf("\n", first.src - 1) + 1;
	const lead = /^[ \t]*/.exec(map.source.slice(lineStart, first.src))?.[0] ?? "";
	return lead.replace(/\t/g, "    ");
}

interface Sel {
	seg: Seg;
	a: number;
	b: number;
}

function runText(map: LeafMap, run: Sel[]): string {
	const lines: string[] = [];
	let cur: string | undefined;
	let prev: Seg | undefined;
	for (const { seg, a, b } of run) {
		if (map.fence[seg.row]) {
			if (cur !== undefined) lines.push(cur);
			cur = undefined;
			prev = undefined;
			continue;
		}
		const cells = contentCells(segCells(map, seg, a, b));
		const text = cells.map((c) => (c.ws ? " " : c.ch)).join("");
		const joiner = prev ? softJoin(map, prev, seg) : undefined;
		if (cur !== undefined && joiner !== undefined) cur += text ? joiner + text : "";
		else {
			if (cur !== undefined) lines.push(cur);
			const first = contentCells(segCells(map, seg))[0];
			const coversStart = !first || a <= first.col;
			cur = (coversStart ? indentOf(map, seg) : "") + text;
		}
		prev = seg;
	}
	if (cur !== undefined) lines.push(cur);
	return lines.join("\n");
}

function dedent(text: string): string {
	const lines = text.split("\n");
	const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
	const min = indents.length ? Math.min(...indents) : 0;
	return min ? lines.map((l) => l.slice(min)).join("\n") : text;
}

function cellText(map: LeafMap, ref: TableRef): string {
	const run = map.segs
		.filter((s) => s.table?.tid === ref.tid && s.table.lrow === ref.lrow && s.table.col === ref.col)
		.map((seg) => ({ seg, a: seg.start, b: seg.end }));
	return runText(map, run).replace(/\s*\n\s*/g, " ").trim();
}

function tableText(map: LeafMap, run: Sel[]): string {
	const tid = run[0].seg.table!.tid;
	const touched = run.filter((s) => contentCells(segCells(map, s.seg, s.a, s.b)).length > 0).map((s) => s.seg.table!);
	const refs = touched.length ? touched : run.map((s) => s.seg.table!);
	const lrows = [...new Set(refs.map((r) => r.lrow))].sort((x, y) => x - y);
	const allCols = [...new Set(map.segs.filter((s) => s.table?.tid === tid).map((s) => s.table!.col))].sort((x, y) => x - y);
	const cols = lrows.length === 1 ? [...new Set(refs.map((r) => r.col))].sort((x, y) => x - y) : allCols;
	const from = cols[0];
	const to = cols.at(-1)!;
	return lrows
		.map((lrow) =>
			allCols
				.filter((col) => col >= from && col <= to)
				.map((col) => cellText(map, { tid, lrow, col }))
				.join("\t"),
		)
		.join("\n");
}

function selectedSegs(map: LeafMap, ranges: RowRanges): Sel[] {
	const out: Sel[] = [];
	for (const seg of map.segs) {
		const range = ranges.get(seg.row);
		if (!range) continue;
		const a = Math.max(seg.start, range[0]);
		const b = Math.min(seg.end, range[1]);
		if (b > a || (!seg.table && isBlank(map.rows[seg.row]))) out.push({ seg, a, b });
	}
	return out;
}

const sameCell = (x?: TableRef, y?: TableRef) => !!x && !!y && x.tid === y.tid && x.lrow === y.lrow && x.col === y.col;

/** Selected segments, narrowed to one table cell when the drag starts and ends inside that cell. */
function selection(map: LeafMap, ranges: RowRanges): { sel: Sel[]; singleCell: boolean } {
	const sel = selectedSegs(map, ranges);
	const rows = [...ranges.keys()].sort((x, y) => x - y);
	if (!rows.length) return { sel, singleCell: false };
	const tableAt = (row: number, col: number) =>
		map.rowSegs[row]?.map((i) => map.segs[i]).find((s) => s.table && col >= s.start - 1 && col <= s.end)?.table;
	const first = tableAt(rows[0], ranges.get(rows[0])![0]);
	const last = tableAt(rows.at(-1)!, ranges.get(rows.at(-1)!)![1] - 1);
	if (!sameCell(first, last)) return { sel, singleCell: false };
	return { sel: sel.filter((s) => sameCell(s.seg.table, first)), singleCell: true };
}

/** Text for a selection inside one leaf. */
export function leafText(map: LeafMap, ranges: RowRanges, format: CopyFormat): string {
	const { sel, singleCell } = selection(map, ranges);
	if (!sel.length) return "";
	if (format === "markdown") return markdownText(map, sel, singleCell);
	if (singleCell) return runText(map, sel).trim();
	const parts: string[] = [];
	for (let i = 0; i < sel.length; ) {
		const tid = sel[i].seg.table?.tid;
		let j = i;
		while (j < sel.length && sel[j].seg.table?.tid === tid) j++;
		const run = sel.slice(i, j);
		parts.push(tid ? tableText(map, run) : runText(map, run));
		i = j;
	}
	return dedent(parts.join("\n"));
}

function markdownText(map: LeafMap, sel: Sel[], singleCell: boolean): string {
	const cells = sel.flatMap((s) => segCells(map, s.seg, s.a, s.b)).filter((c) => c.src >= 0);
	if (!cells.length) return "";
	let start = Math.min(...cells.map((c) => c.src));
	let end = Math.max(...cells.map((c) => c.srcEnd));
	const firstSel = sel[0];
	const lastSel = sel.at(-1)!;
	const firstContent = contentCells(segCells(map, firstSel.seg))[0];
	const lastContent = contentCells(segCells(map, lastSel.seg)).at(-1);
	const wholeLines = !singleCell && (sel.some((s) => s.seg.table) || sel.length > 1);
	if (!singleCell && (wholeLines || !firstContent || firstSel.a <= firstContent.col)) {
		start = map.source.lastIndexOf("\n", start - 1) + 1;
	}
	if (!singleCell && (wholeLines || !lastContent || lastSel.b >= lastContent.col + lastContent.w)) {
		const nl = map.source.indexOf("\n", end);
		end = nl < 0 ? map.source.length : nl;
	}
	// A fence row selected without its content still expands to the fence lines.
	return map.source.slice(start, end).replace(/\s+$/, "");
}

/** Leaf-local [start, end) of selected content on a row, for highlighting exactly what will be copied. */
export function highlightRange(map: LeafMap, ranges: RowRanges, row: number): [number, number] | undefined {
	const { sel, singleCell } = selection(map, ranges);
	let lo = Number.MAX_SAFE_INTEGER;
	let hi = -1;
	for (const s of sel) {
		if (s.seg.row !== row) continue;
		const full = s.seg.table && !singleCell;
		const cells = contentCells(segCells(map, s.seg, full ? s.seg.start : s.a, full ? s.seg.end : s.b));
		if (!cells.length) continue;
		lo = Math.min(lo, cells[0].col);
		hi = Math.max(hi, cells.at(-1)!.col + cells.at(-1)!.w);
	}
	return hi < 0 ? undefined : [lo, hi];
}

/** Rows and columns of the logical (source) line through a point: soft wraps and table cells stay together. */
export function logicalLine(map: LeafMap, row: number, col: number): { r0: number; c0: number; r1: number; c1: number } | undefined {
	const index = map.rowSegs[row]?.find((i) => col >= map.segs[i].start && col < map.segs[i].end);
	if (index === undefined) return undefined;
	const segs = map.segs;
	let i0 = index;
	let i1 = index;
	if (segs[index].table) {
		const cell = segs.filter((s) => sameCell(s.table, segs[index].table));
		i0 = segs.indexOf(cell[0]);
		i1 = segs.indexOf(cell.at(-1)!);
	} else {
		while (i0 > 0 && !segs[i0 - 1].table && softJoin(map, segs[i0 - 1], segs[i0]) !== undefined) i0--;
		while (i1 + 1 < segs.length && !segs[i1 + 1].table && softJoin(map, segs[i1], segs[i1 + 1]) !== undefined) i1++;
	}
	const first = contentCells(segCells(map, segs[i0]))[0];
	const last = contentCells(segCells(map, segs[i1])).at(-1);
	if (!first || !last) return undefined;
	return { r0: segs[i0].row, c0: first.col, r1: segs[i1].row, c1: last.col + last.w };
}

export function blockAt(map: LeafMap, row: number): Block | undefined {
	return map.blocks.find((b) => row >= b.r0 && row <= b.r1);
}

/** Full-width row ranges covering rows r0..r1. */
export function fullRows(r0: number, r1: number): RowRanges {
	const ranges: RowRanges = new Map();
	for (let r = r0; r <= r1; r++) ranges.set(r, [0, Number.MAX_SAFE_INTEGER]);
	return ranges;
}

export function rowEnd(map: LeafMap, row: number): number {
	const cells = map.rows[row] ?? [];
	const last = contentCells(cells).at(-1);
	return last ? last.col + last.w : 0;
}

export function rowCells(map: LeafMap, row: number): Cell[] {
	return map.rows[row] ?? [];
}
