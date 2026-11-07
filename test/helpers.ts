import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import {
	type FauxModelDefinition,
	type FauxResponseStep,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RegisterController, RegisterOptions } from "../src/controller.ts";
import { installRegister } from "../src/extension.ts";

export async function fixture(
	t: TestContext,
	options: {
		before?: (pi: ExtensionAPI) => void;
		after?: (pi: ExtensionAPI) => void;
		manager?: (cwd: string, agentDir: string) => SessionManager;
		contextWindow?: number;
		keepRecentTokens?: number;
		agentDir?: string;
		codemode?: boolean;
		storeFactory?: RegisterOptions["storeFactory"];
		models?: FauxModelDefinition[];
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "pi-register-integration-"));
	const cwd = join(root, "work");
	const agentDir = options.agentDir ?? join(root, "agent");
	await mkdir(cwd);
	await mkdir(agentDir, { recursive: true });
	let cleanupRuntime: (() => void) | undefined;
	t.after(async () => {
		cleanupRuntime?.();
		await rm(root, { recursive: true, force: true });
	});
	const faux = fauxProvider({
		models: options.models ?? [
			{ id: "register-test", contextWindow: options.contextWindow ?? 100_000, maxTokens: 4_096, reasoning: true },
		],
		tokenSize: { min: 100, max: 200 },
	});
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey(faux.provider.id, "test-key-not-a-credential");
	const model = runtime.getModel(faux.provider.id, "register-test");
	assert.ok(model);
	const settings = SettingsManager.inMemory({
		packages: [],
		extensions: [],
		...(options.codemode ? { defaultTools: ["+codemode"] } : {}),
		compaction: { enabled: true, keepRecentTokens: options.keepRecentTokens ?? 200 },
		retry: { enabled: false },
	});
	let controller: RegisterController | undefined;
	let context: ExtensionContext | undefined;
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		extensionFactories: [
			(pi) => {
				options.before?.(pi);
				controller = installRegister(pi, { agentDir, storeFactory: options.storeFactory });
				options.after?.(pi);
				pi.on("session_start", (_event, ctx) => {
					context = ctx;
				});
			},
			...(options.codemode ? [createCodemodeExtension({ mode: "on" })] : []),
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are an isolated test agent. Complete the user's task.",
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = options.manager?.(cwd, agentDir) ?? SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime: runtime,
		resourceLoader: loader,
		thinkingLevel: "medium",
		settingsManager: settings,
		sessionManager: manager,
	});
	const errors: string[] = [];
	const notices: string[] = [];
	const ui = new Proxy(
		{
			notify: (message: string) => {
				notices.push(message);
			},
			setStatus: () => undefined,
		} as unknown as ExtensionUIContext,
		{
			get: (target, property, receiver) => Reflect.get(target, property, receiver) ?? (() => undefined),
		},
	);
	await session.bindExtensions({ onError: (error) => errors.push(error.error), uiContext: ui });
	assert.ok(controller);
	assert.ok(context);
	cleanupRuntime = () => {
		controller?.stop();
		session.dispose();
	};
	const requests: { context: TranscriptContext; aborted: boolean }[] = [];
	function respond(responses: FauxResponseStep[]) {
		faux.setResponses(
			responses.map((step) => async (input, opts, state, requestModel) => {
				requests.push({ context: structuredClone(input), aborted: opts?.signal?.aborted === true });
				return typeof step === "function" ? step(input, opts, state, requestModel) : step;
			}),
		);
	}
	return {
		root,
		cwd,
		agentDir,
		faux,
		runtime,
		loader,
		settings,
		session,
		manager,
		get controller() {
			assert.ok(controller);
			return controller;
		},
		get context() {
			assert.ok(context);
			return context;
		},
		errors,
		notices,
		requests,
		respond,
	};
}

export function text(context: TranscriptContext): string {
	return context.messages
		.map((message) => {
			if (message.role === "system")
				return typeof message.content === "string" ? message.content : JSON.stringify(message);
			if (typeof message.content === "string") return message.content;
			return message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
		})
		.join("\n");
}
