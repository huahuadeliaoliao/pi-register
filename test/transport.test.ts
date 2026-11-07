import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { PUBLICATION_TYPE } from "../src/model.ts";
import { fixture } from "./helpers.ts";

test("public cancellation stops the built-in HTTP transport before any outbound request", async (t) => {
	let outbound = 0;
	const server = createServer((_request, response) => {
		outbound++;
		response.writeHead(500, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: { message: "This endpoint must not be called." } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const f = await fixture(t, {
		before: (pi) => {
			pi.on("context", (event) => ({
				messages: event.messages.filter(
					(message) => message.role !== "custom" || message.customType !== PUBLICATION_TYPE,
				),
			}));
		},
	});
	f.runtime.registerProvider("local-transport", {
		api: "openai-completions",
		apiKey: "local-test-placeholder",
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		models: [
			{
				id: "transport",
				name: "Transport fixture",
				reasoning: false,
				input: ["text"],
				contextWindow: 100_000,
				maxTokens: 1024,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
	const model = f.runtime.getModel("local-transport", "transport");
	assert.ok(model);
	await f.session.setModel(model);
	await f.session.prompt("Continue the task.");
	const assistant = [...f.session.messages].reverse().find((message) => message.role === "assistant");
	assert.ok(assistant?.role === "assistant");
	// ModelRuntime may normalize a pre-stream AbortError as stopReason="error".
	// The invariant is cancellation before HTTP, not a provider-specific enum.
	assert.ok(assistant.stopReason === "aborted" || assistant.stopReason === "error");
	assert.match(assistant.errorMessage ?? "", /abort/i);
	assert.equal(outbound, 0);
	assert.ok(f.notices.some((message) => message.includes("changed or duplicated")));
	assert.deepEqual(f.errors, []);
});
