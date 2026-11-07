import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { newRevision } from "../src/model.ts";
import { resolveAdoption } from "../src/projection.ts";
import { RegisterViewer } from "../src/viewer.ts";
import { fixture } from "./helpers.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
const keys = new KeybindingsManager(TUI_KEYBINDINGS);

function viewer(body: string) {
	let rows = 12;
	let closed = 0;
	let redraws = 0;
	const revision = newRevision(body, undefined, "create", "viewer-test");
	const component = new RegisterViewer(
		revision,
		theme,
		keys,
		() => rows,
		() => redraws++,
		() => closed++,
	);
	return {
		component,
		revision,
		resize: (n: number) => {
			rows = n;
		},
		closed: () => closed,
		redraws: () => redraws,
	};
}

test("viewer shows full plain body without machine envelope and handles empty content", () => {
	const v = viewer("标题\n\n**literal Markdown**\nlast line");
	const output = v.component
		.render(100)
		.map((line) => line.trimEnd())
		.join("\n");
	assert.match(output, /Session Register/);
	assert.ok(output.includes(v.revision.body));
	assert.doesNotMatch(output, /session-register revision|profile=|sha256:/);
	assert.match(viewer("").component.render(80).join("\n"), /Register 当前为空/);
});

test("viewer scrolls, pages, reaches both ends, resizes and closes without editing", () => {
	const v = viewer(Array.from({ length: 120 }, (_, i) => `row-${i} 中文🙂`).join("\n"));
	assert.match(v.component.render(80).join("\n"), /row-0 /);
	v.component.handleInput("\u001b[6~"); // PageDown
	assert.doesNotMatch(v.component.render(80).join("\n"), /row-0 /);
	v.component.handleInput("\u001b[F"); // End
	assert.match(v.component.render(80).join("\n"), /row-119 /);
	v.component.handleInput("\u001b[5~"); // PageUp
	assert.doesNotMatch(v.component.render(80).join("\n"), /row-119 /);
	v.component.handleInput("\u001b[H"); // Home
	v.component.handleInput("\u001b[B"); // Down
	assert.match(v.component.render(80)[1] ?? "", /row-1 /);
	v.component.handleInput("\u001b[A"); // Up
	assert.match(v.component.render(80)[1] ?? "", /row-0 /);
	v.component.handleMouse({ type: "wheel", wheelDelta: 3 } as TuiMouseEvent);
	assert.match(v.component.render(80)[1] ?? "", /row-3 /);
	v.resize(8);
	for (const width of [8, 20, 80]) {
		v.component.invalidate();
		const lines = v.component.render(width);
		assert.ok(lines.length <= 8);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	v.component.handleInput("x");
	assert.equal(v.closed(), 0);
	v.component.handleInput("\u001b");
	assert.equal(v.closed(), 1);
	assert.ok(v.redraws() > 0);
	assert.ok(v.revision.body.endsWith("row-119 中文🙂"));
});

test("register only views adopted content; removed subcommands have no side effects", async (t) => {
	const f = await fixture(t);
	const initial = resolveAdoption(f.manager.getBranch());
	assert.ok(initial);
	const body = "Current human-readable notes\n第二行";
	f.respond([
		fauxAssistantMessage(
			fauxToolCall("register_write", { base_revision: initial.revision.id, action: "append", text: body }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await f.session.prompt("Save notes.");
	const adopted = resolveAdoption(f.manager.getBranch());
	assert.ok(adopted);
	f.controller.write(f.context, {
		base_revision: adopted.revision.id,
		action: "append",
		text: "\nPending, not yet adopted",
	});
	const before = structuredClone(f.manager.getBranch());
	const requests = f.requests.length;
	let opens = 0;
	const ctx = {
		...f.context,
		mode: "tui",
		ui: {
			...f.context.ui,
			custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
				opens++;
				let closed = false;
				const component = await factory(
					{ terminal: { rows: 24 }, requestRender() {} } as Parameters<typeof factory>[0],
					theme,
					keys as Parameters<typeof factory>[2],
					() => {
						closed = true;
					},
				);
				const rendered = component.render(100).join("\n");
				assert.ok(rendered.includes(body));
				assert.doesNotMatch(rendered, /Pending, not yet adopted/);
				component.handleInput?.("\u001b");
				assert.equal(closed, true);
			},
		},
	} as ExtensionContext;
	await f.controller.command("", ctx);
	assert.equal(opens, 1);
	for (const args of ["show", "status", "export removed.json", "import removed.json", "unknown"]) {
		await f.controller.command(args, ctx);
		assert.match(f.notices.at(-1) ?? "", /Usage: \/register$/);
	}
	assert.equal(opens, 1);
	await f.controller.command("", { ...f.context, mode: "rpc" });
	assert.equal(f.notices.at(-1), body);
	assert.deepEqual(f.manager.getBranch(), before, "viewing must not append or adopt entries");
	assert.equal(f.requests.length, requests, "viewing must not call the model");
});
