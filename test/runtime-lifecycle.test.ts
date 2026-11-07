import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { installRegister } from "../src/extension.ts";
import { render, renderEnvelope } from "../src/model.ts";
import { assertCurrent, resolveAdoption } from "../src/projection.ts";
import { fixture, text } from "./helpers.ts";

test("public runtime fork, clone, new and resume preserve selected adoption and isolate later writes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "register-runtime-"));
	const cwd = join(root, "work"),
		agentDir = join(root, "agent"),
		sessionDir = join(root, "sessions");
	await mkdir(cwd);
	await mkdir(agentDir);
	const fake = fauxProvider({
		models: [{ id: "register-test", contextWindow: 100_000, maxTokens: 4096 }],
		tokensPerSecond: 1_000_000,
	});
	const models = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	models.registerNativeProvider(fake.provider);
	await models.setRuntimeApiKey(fake.provider.id, "synthetic");
	const model = models.getModel(fake.provider.id, "register-test");
	assert.ok(model);
	const errors: string[] = [];
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime: models,
			settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], retry: { enabled: false } }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
				systemPrompt: "Isolated runtime lifecycle test.",
				extensionFactories: [
					(pi) => {
						installRegister(pi, { agentDir });
					},
				],
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model,
				thinkingLevel: "medium",
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const host = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.create(cwd, sessionDir),
	});
	t.after(async () => {
		await host.dispose();
		await rm(root, { recursive: true, force: true });
	});
	const bind = async () => {
		await host.session.bindExtensions({
			onError: (error) => {
				errors.push(error.error);
			},
		});
	};
	host.setRebindSession(bind);
	await bind();
	function current() {
		const value = resolveAdoption(host.session.sessionManager.getBranch());
		assert.ok(value);
		assertCurrent(host.session.sessionManager.getBranch(), value);
		return value;
	}
	async function write(body: string, prompt: string) {
		fake.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("register_write", { base_revision: current().revision.id, action: "replace", text: body })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("saved"),
		]);
		await host.session.prompt(prompt);
		assert.equal(current().revision.body, body);
	}
	async function exposed(body: string) {
		const snapshot = current();
		assert.equal(snapshot.revision.body, body);
		fake.setResponses([
			(context) => {
				const carrier = assertCurrent(host.session.sessionManager.getBranch(), snapshot);
				assert.ok(text(context).includes(renderEnvelope(carrier.envelope)));
				return fauxAssistantMessage("visible");
			},
		]);
		await host.session.prompt("Continue without changing notes.");
		assert.equal(host.session.getLastAssistantText(), "visible");
	}
	await write("ancestor", "Record the initial state.");
	const ancestor = current();
	await write("later parent state", "Future branch work.");
	const parent = current();
	const originalFile = host.session.sessionFile;
	assert.ok(originalFile);
	const point = host.session.sessionManager
		.getBranch()
		.reverse()
		.find((entry) => entry.type === "message" && entry.message.role === "user");
	assert.ok(point);
	assert.equal((await host.fork(point.id)).cancelled, false);
	const forkFile = host.session.sessionFile;
	assert.ok(forkFile);
	assert.notEqual(forkFile, originalFile);
	assert.equal(current().revision.id, ancestor.revision.id);
	await exposed("ancestor");
	await write("fork-only state", "Change this fork.");
	assert.equal(resolveAdoption(SessionManager.open(originalFile).getBranch())?.revision.id, parent.revision.id);
	await host.switchSession(originalFile);
	await exposed("later parent state");
	const clonePoint = host.session.sessionManager.getLeafId();
	assert.ok(clonePoint);
	assert.equal((await host.fork(clonePoint, { position: "at" })).cancelled, false); // /clone uses this public runtime path.
	assert.notEqual(host.session.sessionFile, originalFile);
	assert.equal(current().revision.id, parent.revision.id);
	await exposed("later parent state");
	await write("clone-only state", "Change only the clone.");
	assert.equal(resolveAdoption(SessionManager.open(originalFile).getBranch())?.revision.id, parent.revision.id);
	await host.newSession();
	await exposed("");
	assert.notEqual(current().revision.id, parent.revision.id);
	await host.switchSession(forkFile);
	await exposed("fork-only state");
	assert.deepEqual(errors, []);
});

test("switching to a model too small for the protected floor rejects requests without changing body or meter", async (t) => {
	const f = await fixture(t, {
		models: [
			{ id: "register-test", contextWindow: 150_000, maxTokens: 4096 },
			{ id: "small", contextWindow: 32_000, maxTokens: 1024 },
		],
	});
	const initial = resolveAdoption(f.manager.getBranch());
	assert.ok(initial);
	const body = "information ".repeat(8000);
	f.respond([
		fauxAssistantMessage(
			[fauxToolCall("register_write", { base_revision: initial.revision.id, action: "replace", text: body })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("saved"),
	]);
	await f.session.prompt("Keep this long working body.");
	const before = resolveAdoption(f.manager.getBranch());
	assert.ok(before);
	const small = f.runtime.getModel(f.faux.provider.id, "small"),
		large = f.runtime.getModel(f.faux.provider.id, "register-test");
	assert.ok(small && large);
	await f.session.setModel(small);
	f.respond([fauxAssistantMessage("must not dispatch")]);
	const previous = f.requests.length;
	await f.session.prompt("Continue on the smaller model.");
	assert.equal(f.requests.slice(previous).filter((request) => !request.aborted).length, 0);
	assert.equal(resolveAdoption(f.manager.getBranch())?.revision.id, before.revision.id);
	assert.equal(resolveAdoption(f.manager.getBranch())?.revision.profile, before.revision.profile);
	await f.session.setModel(large);
	f.respond([
		(context) => {
			assert.ok(text(context).includes(render(before)));
			return fauxAssistantMessage("recovered");
		},
	]);
	await f.session.prompt("Continue after returning to the larger model.");
	assert.equal(f.session.getLastAssistantText(), "recovered");
	assert.equal(resolveAdoption(f.manager.getBranch())?.revision.body, body);
});
