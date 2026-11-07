import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	matchesKey,
	ScrollView,
	Text,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Revision } from "./model.ts";
import { CAPACITY } from "./text.ts";

/** A UI-only snapshot. Opening/closing it never publishes a session entry. */
export class RegisterViewer implements Component {
	private readonly scroll: ScrollView;
	private readonly revision: Revision;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly rows: () => number;
	private readonly redraw: () => void;
	private readonly close: () => void;

	constructor(
		revision: Revision,
		theme: Theme,
		keys: KeybindingsManager,
		rows: () => number,
		redraw: () => void,
		close: () => void,
	) {
		this.revision = revision;
		this.theme = theme;
		this.keys = keys;
		this.rows = rows;
		this.redraw = redraw;
		this.close = close;
		this.scroll = new ScrollView(new Text(revision.body || "Register 当前为空。", 0, 0));
	}

	render(width: number): string[] {
		const height = Math.max(1, this.rows() - 4);
		const lines = this.scroll.render(Math.max(1, width));
		// Explicit clipping also works in regular-mode overlays, whose renderer
		// consumes lines rather than the fullscreen layout tree.
		this.scroll.updateLayout(lines.length, height, this.redraw);
		const start = this.scroll.scrollTop;
		const title = `Session Register · ${this.revision.used.toLocaleString()} / ${CAPACITY.toLocaleString()}`;
		const footer = `${start + 1}–${Math.min(start + height, lines.length)} / ${lines.length} · ↑↓ PgUp/PgDn · Home/End · Esc 关闭`;
		return [
			truncateToWidth(this.theme.fg("accent", title), width),
			...lines.slice(start, start + height),
			truncateToWidth(this.theme.fg("dim", footer), width),
		];
	}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (this.keys.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
		else if (this.keys.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
		else if (this.keys.matches(data, "tui.select.pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
		else if (this.keys.matches(data, "tui.select.pageDown")) this.scroll.scrollBy(this.scroll.viewportHeight);
		else if (matchesKey(data, "home")) this.scroll.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel") return undefined;
		this.scroll.scrollBy(event.wheelDelta ?? 0);
		return { handled: true };
	}

	invalidate(): void {
		this.scroll.invalidate();
	}
}

export async function showRegister(ctx: ExtensionContext, revision: Revision): Promise<void> {
	if (ctx.mode !== "tui") {
		// RPC supports notifications but not custom TUI components.
		ctx.ui.notify(revision.body || "Register 当前为空。", "info");
		return;
	}
	await ctx.ui.custom<void>(
		(tui, theme, keys, done) =>
			new RegisterViewer(
				revision,
				theme,
				keys,
				() => tui.terminal.rows,
				() => tui.requestRender(),
				done,
			),
		{ overlay: true, overlayOptions: { width: "95%", maxHeight: "100%" } },
	);
}
