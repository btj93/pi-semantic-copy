# pi-semantic-copy

> **Experimental.** This extension patches private internals of Pi's fullscreen mode. It is tested with
> **Pi 1.5.x** only. On other versions it warns at startup, and it switches itself off if the methods it
> patches are missing.

Pi's fullscreen transcript copies exactly what it draws, so a mouse selection picks up blockquote
gutters (`│ `), table borders, code fences, padding, and a hard line break at every soft wrap.
This extension copies the text the transcript *means* instead. The rendering itself does not change.

| You select | Pi copies | With pi-semantic-copy |
|---|---|---|
| A wrapped blockquote | `│ The quick brown fox jumps over the`<br>`│ lazy dog.` | `The quick brown fox jumps over the lazy dog.` |
| Wrapped Japanese (no spaces between words) | `今日は天気が良いので、公`<br>`園まで散歩に…` | `今日は天気が良いので、公園まで散歩に…` |
| Part of one table cell | The row slice, with borders and the neighbouring cells | Only that cell's text, rejoined across wraps |
| Several table rows | Box-drawing characters | Tab-separated rows that paste into a spreadsheet |
| A code block | The fences and the render indent | The code, with its own indentation |

## Install

```bash
pi install npm:pi-semantic-copy   # once published
pi install ./pi-semantic-copy     # local checkout
```

It needs fullscreen mode (`"tuiMode": "fullscreen"`, Pi's default).

## Use

### Mouse

| Action | Result |
|---|---|
| Drag | Copies the source text of the selection (with Pi's default `fullscreenCopyOnSelect`). The highlight shows only what will be copied. |
| Drag that starts and ends in one table cell | Copies only that cell |
| Double-click | Word, as before |
| Triple-click | The whole source line: a wrapped paragraph line, list item or table cell |
| Fourth click | The whole block: paragraph, list, table, code block or quote |
| Alt+click | Selects and copies the block under the pointer |

`Ctrl+X` (`app.message.copy`) uses the same text when `fullscreenCopyOnSelect` is `false`.

### Keyboard

`/copy-block` picks a block. It starts on the newest block.

| Key | Action |
|---|---|
| `j` / `k`, `}` / `{` | Next / previous block |
| `y`, `Enter` | Copy as plain text |
| `Y` | Copy as Markdown |
| `v`, `V` | Switch to free selection |
| `Esc`, `q` | Quit |

`/copy-mode` (or `Alt+C`) is a tmux/vim-style copy mode.

| Key | Action |
|---|---|
| `h` `j` `k` `l`, arrows | Move |
| `w` / `b`, `0` / `^` / `$` | Word forward / back, line start / first text / end |
| `g` / `G`, `Ctrl+U` / `Ctrl+D`, `Ctrl+B` / `Ctrl+F` | Top / bottom, half page, full page |
| `{` / `}` | Previous / next block |
| `v` / `V` / `B` | Select by character / source line / block |
| `o` | Swap the cursor and the selection's other end |
| `y`, `Enter` / `Y` | Copy plain / copy Markdown |
| `Esc` / `q` | Clear the selection / quit |

### Format

`/semantic-copy plain|markdown|off` sets what mouse copies produce. `plain` (default) gives readable
text. `markdown` gives the original Markdown source of the selected lines. `off` restores Pi's own copy.
Run `/semantic-copy` with no argument to see the current mode and any version warning.

## Terminal notes

- **Alt+click** needs a terminal that reports Alt in mouse events. Some terminals use Option+drag for
  their own rectangular selection, or send Option as a character. The fourth click does the same job
  everywhere.
- **Alt+C** needs Option to act as Meta (macOS Terminal: "Use Option as Meta key"; iTerm2: "Esc+").
  `/copy-mode` always works.

## Limits

- Only content drawn by Pi's `Markdown` and `Text` components is mapped. Rows drawn by other
  components, such as custom tool renderers from other extensions, copy the way Pi copies them.
- Rendered LaTeX and text rewritten by Markdown transformers map only partly back to the source.
- Regular (non-fullscreen) mode is not supported. There the terminal owns the selection.

## How it works

For each `Markdown` or `Text` component on screen, the extension aligns the rendered graphemes with the
component's source text (Myers diff in windows, cached per render). Cells that align nothing, such as
borders, gutters and padding, are decoration. A break between two rows is a soft wrap when the source
between them holds no newline. Table cells are read column by column from the box-drawing grid.

It replaces six private `TuiAltScreen` methods: `getActiveSelectionText`, `applySelection`,
`getSelectionColumns`, `getLineSelection`, `getClickCount` and `handleSelectionMouseEvent`. Each falls
back to Pi's original on any error. A component whose first rendered row does not match the screen is
copied the old way.

## Develop

```bash
npm install
npm run check   # tsc
npm test        # against the pinned Pi devDependency
PI_PACKAGE_DIR=/path/to/installed/pi-coding-agent npm test   # against another Pi
```

CI runs the type check and tests against the pinned Pi and against the latest Pi release, on every
push and weekly.

## License

Apache License 2.0. See [LICENSE](LICENSE).
