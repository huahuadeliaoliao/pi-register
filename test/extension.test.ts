import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

test("the factory registers capabilities without accessing session resources", () => {
	const tools: string[] = [];
	const events: string[] = [];
	const commands: string[] = [];
	const api = new Proxy({} as ExtensionAPI, {
		get(_target, property) {
			if (property === "on")
				return (name: string) => {
					events.push(name);
					return () => undefined;
				};
			if (property === "registerTool") return (tool: { name: string }) => tools.push(tool.name);
			if (property === "registerCommand") return (name: string) => commands.push(name);
			throw new Error(`Factory accessed session resources: ${String(property)}`);
		},
		set() {
			throw new Error("Factory mutated the host API.");
		},
	});
	assert.equal(register(api), undefined);
	assert.deepEqual(tools, ["register_write", "register_history", "register_restore"]);
	assert.deepEqual(commands, ["register"]);
	assert.ok(events.includes("session_start"));
	assert.ok(events.includes("session_before_compact"));
});

test("pi loads all runtime TypeScript files in an isolated agent directory", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-register-loader-"));
	t.after(async () => rm(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir);

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Isolated Register scaffold test.",
	});
	await loader.reload();

	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.equal(loaded.extensions[0]?.tools.size, 3);
});
