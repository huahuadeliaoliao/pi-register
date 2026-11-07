import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { measure, PROFILE } from "../src/text.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const hostRoot = fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
const tokenizerRoot = fileURLToPath(new URL("../", import.meta.resolve("js-tiktoken")));
const base64Root = dirname(fileURLToPath(import.meta.resolve("base64-js")));

const providerFixture = String.raw`
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";

export default function (pi) {
 const phase = process.env.REGISTER_PACK_PHASE;
 const expected = process.env.REGISTER_PACK_BODY;
 const observations = [];
 let mainCalls = 0;
 let compacted = false;
 const core = createFauxCore({ provider: "installed-test", api: "faux-register-installed",
  models: [{ id: "installed", reasoning: true, contextWindow: 100000, maxTokens: 4096 }],
  tokensPerSecond: 1000000, tokenSize: { min: 10000, max: 10000 } });
 const respond = (context, options) => {
  assert.equal(options.reasoning, "medium");
  assert.ok(!options.signal?.aborted);
  const system = getCurrentSystemPrompt(context.messages);
  const text = context.messages.map(message => typeof message.content === "string" ? message.content :
   Array.isArray(message.content) ? message.content.filter(block => block.type === "text").map(block => block.text).join("\n") : "").join("\n");
  if (system.startsWith("You are a context summarization assistant.")) {
   assert.ok(!text.includes("<session-register revision="));
   observations.push({ kind: "summary", reasoning: options.reasoning });
   return fauxAssistantMessage("Ordinary conversation summary.");
  }
  assert.ok(system.includes("Use Register as your ongoing workspace"));
  assert.ok(system.includes("Keep these working materials here rather than scattering them across Markdown files or other scratch documents in the project."));
  assert.ok(system.includes("Create new project documents when the user requests a document or an established project requirement explicitly calls for one."));
  assert.ok(system.includes("Concise summaries, fragments, shorthand"));
  assert.ok(system.includes("preserve exact values when needed"));
  const frames = [...text.matchAll(/<session-register revision="([^"]+)" adoption="([^"]+)" profile="([^"]+)" capacity="30000" used="(\d+)" remaining="(\d+)">\n([\s\S]*?)\n<\/session-register>/g)];
  const initial = [...text.matchAll(/<session-register-initial-state initial-revision="([^"]+)" profile="([^"]+)" capacity="30000" initial-used="0" initial-remaining="30000" initial-body="" \/>/g)];
  assert.ok(initial.length <= 1, "initial metadata is bounded, not accumulated body versions");
  if (frames.length === 0) {
   assert.equal(initial.length, 1, "an empty current workspace must still provide its writable revision/profile/capacity");
   const origin = initial[0];
   frames.push([origin[0], origin[1], "", origin[2], "0", "30000", ""]);
  }
  assert.equal(frames.length, 1, "packed extension must present exactly one complete frame");
  const frame = frames[0];
  const body = frame[6];
  const used = Number(frame[4]);
  assert.equal(used + Number(frame[5]), 30000);
  observations.push({ kind: "main", revision: frame[1], profile: frame[3], used,
   bodyHash: createHash("sha256").update(body).digest("hex"), reasoning: options.reasoning });
  if (phase === "resume") {
   assert.equal(body, expected);
   mainCalls++;
   return fauxAssistantMessage("PACKED_RESUME_DONE");
  }
  if (mainCalls++ === 0) {
   assert.equal(body, "");
   return fauxAssistantMessage(fauxToolCall("register_write", { base_revision: frame[1], action: "append", text: expected }), { stopReason: "toolUse" });
  }
  assert.equal(body, expected);
  return fauxAssistantMessage("PACKED_WRITE_DONE\n" + "Ordinary implementation progress. ".repeat(80));
 };
 core.setResponses(Array.from({ length: 10 }, () => respond));
 pi.registerProvider("installed-test", { api: core.api, baseUrl: "http://fixture.invalid", apiKey: "synthetic-not-a-credential",
  models: core.models.map(model => ({ id: model.id, name: model.name, reasoning: model.reasoning,
   input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens })),
  streamSimple: core.streamSimple });
 pi.on("agent_settled", async (_event, ctx) => {
  if (phase === "persist" && mainCalls === 2 && !compacted) {
   await new Promise((resolve, reject) => ctx.compact({
    onComplete: result => { assert.ok(result.summary.includes(expected)); resolve(); }, onError: reject }));
   compacted = true;
  }
  writeFileSync(process.env.REGISTER_PACK_OBSERVATIONS, JSON.stringify({ phase, compacted, observations }), { mode: 0o600 });
 });
}
`;

interface Observation {
	kind: "main" | "summary";
	revision?: string;
	profile?: string;
	used?: number;
	bodyHash?: string;
	reasoning: string;
}
interface PhaseResult {
	phase: string;
	compacted: boolean;
	observations: Observation[];
}

function run(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 30_000): string {
	try {
		return execFileSync(program, args, {
			cwd,
			env,
			encoding: "utf8",
			timeout,
			maxBuffer: 2_000_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const stderr = (error as { stderr?: unknown }).stderr;
		throw new Error(`${String(error)}\n${String(stderr ?? "").slice(-3500)}`);
	}
}

test("a separately installed npm package runs through pi CLI, compacts, cold-recovers from one file, and keeps no-session data out of SQLite", {
	timeout: 90_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-register-installed-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const work = join(directory, "work");
	const install = join(directory, "install with spaces");
	const tarballs = join(directory, "tarballs");
	const home = join(directory, "home");
	const temporary = join(directory, "tmp");
	for (const path of [work, install, tarballs, home, temporary]) await mkdir(path);
	const npmConfig = join(directory, "npmrc");
	await writeFile(npmConfig, "offline=true\naudit=false\nfund=false\n", { mode: 0o600 });
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: temporary,
		LANG: "C.UTF-8",
		TERM: "dumb",
		PI_OFFLINE: "1",
		NPM_CONFIG_USERCONFIG: npmConfig,
		NPM_CONFIG_CACHE: join(directory, "npm-cache"),
	};
	const packed: string[] = [];
	for (const path of [root, tokenizerRoot, base64Root]) {
		const result = JSON.parse(
			run("npm", ["pack", path, "--pack-destination", tarballs, "--ignore-scripts", "--json"], install, env),
		) as { filename: string }[];
		assert.ok(result[0]);
		packed.push(join(tarballs, result[0].filename));
	}
	run(
		"npm",
		["install", ...packed, "--offline", "--omit=dev", "--ignore-scripts", "--legacy-peer-deps", "--package-lock=false"],
		install,
		env,
	);
	const installed = join(install, "node_modules", "pi-register", "index.ts");
	const installedRequire = createRequire(installed);
	const dependency = await realpath(installedRequire.resolve("js-tiktoken/lite"));
	assert.ok(dependency.startsWith(`${install}/`), "runtime dependencies must resolve from the isolated installation");
	const host = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8")) as {
		version: string;
		bin: { pi: string };
	};
	assert.equal(host.version, "1.4.0");
	const cli = join(hostRoot, host.bin.pi);
	const provider = join(directory, "provider.ts");
	await writeFile(provider, providerFixture);
	const agent = join(directory, "agent");
	const recoveredAgent = join(directory, "recovered-agent");
	for (const path of [agent, recoveredAgent]) {
		await mkdir(path);
		await writeFile(
			join(path, "settings.json"),
			JSON.stringify({
				packages: [],
				extensions: [],
				retry: { enabled: false },
				compaction: { enabled: true, keepRecentTokens: 50 },
			}),
		);
	}
	// Exercise pi's package manifest activation, not just an explicit source-file -e.
	for (const path of [agent, recoveredAgent]) {
		run(process.execPath, [cli, "install", dirname(installed)], work, {
			...env,
			PI_CODING_AGENT_DIR: path,
		});
		const configured = JSON.parse(await readFile(join(path, "settings.json"), "utf8")) as { packages?: unknown[] };
		assert.equal(configured.packages?.length, 1);
	}
	const sessions = join(directory, "sessions");
	await mkdir(sessions);
	const common = [
		cli,
		"--offline",
		"--mode",
		"json",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"-e",
		provider,
		"--provider",
		"installed-test",
		"--model",
		"installed",
		"--thinking",
		"medium",
		"--print",
	];
	const body = "Packed body 🧭\r\nLiteral <|endoftext|> remains ordinary text.";
	const phases: PhaseResult[] = [];
	async function phase(name: string, targetAgent: string, expectedBody: string, args: string[]) {
		const observations = join(directory, `${name}-observations.json`);
		const output = run(process.execPath, [...common, ...args, "Complete the isolated package check."], work, {
			...env,
			PI_CODING_AGENT_DIR: targetAgent,
			REGISTER_PACK_PHASE: name,
			REGISTER_PACK_BODY: expectedBody,
			REGISTER_PACK_OBSERVATIONS: observations,
		});
		assert.ok(output.includes(name === "resume" ? "PACKED_RESUME_DONE" : "PACKED_WRITE_DONE"), output.slice(-3500));
		const result = JSON.parse(await readFile(observations, "utf8")) as PhaseResult;
		const last = result.observations.filter((entry) => entry.kind === "main").at(-1);
		assert.equal(last?.profile, PROFILE);
		assert.equal(last?.used, measure(expectedBody).used);
		assert.equal(last?.bodyHash, createHash("sha256").update(expectedBody).digest("hex"));
		phases.push(result);
		return result;
	}
	const first = await phase("persist", agent, body, ["--session-dir", sessions]);
	assert.equal(first.compacted, true);
	assert.ok(first.observations.some((entry) => entry.kind === "summary"));
	const files = (await readdir(sessions)).filter((path) => path.endsWith(".jsonl"));
	assert.equal(files.length, 1);
	const source = join(sessions, files[0] as string);
	const entries = (await readFile(source, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line)) as { type: string; details?: { register?: { carrier: boolean } } }[];
	assert.equal(entries.filter((entry) => entry.type === "compaction").at(-1)?.details?.register?.carrier, true);
	const copy = join(directory, "cold-copy.jsonl");
	await copyFile(source, copy);
	const resumed = await phase("resume", recoveredAgent, body, ["--session", copy]);
	assert.equal(
		resumed.observations[0]?.revision,
		first.observations.filter((entry) => entry.kind === "main").at(-1)?.revision,
	);
	const recoveredDb = new DatabaseSync(join(recoveredAgent, "register", "revisions.sqlite"), { readOnly: true });
	try {
		assert.equal(recoveredDb.prepare("SELECT count(*) AS count FROM revisions").get()?.count, 1);
	} finally {
		recoveredDb.close();
	}
	const originalDb = join(agent, "register", "revisions.sqlite");
	const before = (await stat(originalDb)).mtimeMs;
	await phase("ephemeral", agent, "ephemeral-only", ["--no-session", "--session-dir", sessions]);
	assert.equal((await stat(originalDb)).mtimeMs, before);
	assert.deepEqual(
		(await readdir(sessions)).filter((path) => path.endsWith(".jsonl")),
		files,
	);
	const db = new DatabaseSync(originalDb, { readOnly: true });
	try {
		assert.equal(db.prepare("SELECT count(*) AS count FROM revisions").get()?.count, 2);
		assert.equal(
			db.prepare("SELECT count(*) AS count FROM revisions WHERE payload LIKE '%ephemeral-only%'").get()?.count,
			0,
		);
	} finally {
		db.close();
	}
	const evidence = process.env.PI_REGISTER_EVIDENCE_DIR;
	if (evidence) {
		await mkdir(evidence, { recursive: true, mode: 0o700 });
		await writeFile(
			join(evidence, "installed-package.json"),
			JSON.stringify(
				{
					hostVersion: host.version,
					packageHash: createHash("sha256")
						.update(await readFile(packed[0] as string))
						.digest("hex"),
					phases,
					packageManifestActivation: true,
					independentDependencyResolution: true,
					singleFileRecoveryWithoutHistoryDb: true,
					ephemeralDatabaseIsolation: true,
				},
				null,
				2,
			),
			{ mode: 0o600 },
		);
	}
});
