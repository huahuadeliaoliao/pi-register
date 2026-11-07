import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { RegisterController, type RegisterOptions } from "./controller.ts";
import { REGISTER_GUIDANCE } from "./prompts.ts";
import { RegisterError } from "./text.ts";

const Base = Type.String({
	minLength: 1,
	description: "Current revision ID shown in Session Register, or returned by your last staged edit in this batch.",
});
const Namespace = {
	name: "register",
	description: "Maintain the always-present Session Register; inspect history only when recovering past contents.",
};
const Result = Type.Record(Type.String(), Type.Unknown());

function result(action: () => Record<string, unknown>): AgentToolResult<unknown> {
	try {
		const structuredContent = action();
		return {
			content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
			details: structuredContent,
			structuredContent: JSON.parse(JSON.stringify(structuredContent)) as AgentToolResult<unknown>["structuredContent"],
		};
	} catch (error) {
		const structuredContent = {
			state: "error",
			code: error instanceof RegisterError ? error.code : "STORAGE_OR_RUNTIME_ERROR",
			message: error instanceof Error ? error.message : String(error),
			...(error instanceof RegisterError ? error.data : {}),
		};
		return {
			isError: true,
			content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
			details: structuredContent,
			structuredContent: JSON.parse(JSON.stringify(structuredContent)) as AgentToolResult<unknown>["structuredContent"],
		};
	}
}

/** Factory does not open files: session_start owns all session-scoped resources. */
export function installRegister(pi: ExtensionAPI, options: RegisterOptions = {}): RegisterController {
	const controller = new RegisterController(pi, options);
	pi.on("session_start", (_event, ctx) => controller.start(ctx));
	pi.on("session_shutdown", () => controller.stop());
	pi.on("session_tree", (_event, ctx) => controller.tree(ctx));
	pi.on("turn_end", (event, ctx) => controller.boundary(event, ctx));
	pi.on("agent_before_settle", (event, ctx) => controller.boundary(event, ctx));
	pi.on("agent_settled", (_event, ctx) => controller.settled(ctx));
	pi.on("session_before_compact", (event, ctx) => controller.compact(event, ctx));
	pi.on("session_compact", (_event, ctx) => controller.afterCompact(ctx));
	pi.on("context_with_system", (event, ctx) => controller.guard(event.messages, ctx));
	pi.on("before_agent_start", (event) => {
		const guidance = `## Session Register\n\n${REGISTER_GUIDANCE.join("\n\n")}`;
		if (!event.systemPromptOptions.appendSystemPrompt.includes(guidance)) {
			event.systemPromptOptions.appendSystemPrompt +=
				(event.systemPromptOptions.appendSystemPrompt ? "\n\n" : "") + guidance;
		}
	});

	pi.registerTool({
		name: "register_write",
		label: "Edit Register",
		namespace: Namespace,
		description:
			"Modify your current Session Register. Use replace for a full body, append for verbatim text, edit for exact disjoint replacements against the original body, or clear. Supply base_revision to avoid stale writes. Successful changes are stored candidates, published together at the turn boundary before the next model request. An error leaves earlier successful edits in the batch intact. Current contents are already in context.",
		promptSnippet: "Write or edit your always-present session working notes.",
		parameters: Type.Object({
			base_revision: Base,
			action: Type.Union([
				Type.Literal("replace"),
				Type.Literal("edit"),
				Type.Literal("append"),
				Type.Literal("clear"),
			]),
			text: Type.Optional(
				Type.String({
					description: "Required by replace/append; appended exactly as supplied, including any separator.",
				}),
			),
			edits: Type.Optional(
				Type.Array(
					Type.Object({
						oldText: Type.String({ minLength: 1 }),
						newText: Type.String(),
					}),
					{
						minItems: 1,
						description: "Required by edit. Each oldText must match once in the original body; edits cannot overlap.",
					},
				),
			),
		}),
		outputSchema: Result,
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		execute: async (_id, params, _signal, _update, ctx) => result(() => controller.write(ctx, params)),
	});

	pi.registerTool({
		name: "register_history",
		label: "Register history",
		namespace: Namespace,
		description:
			"Recover past Register revisions when needed, not the current body (already in context). Default branch scope follows the current revision ancestry; session scope includes revisions on other branches of this session and explicitly imported history, never unrelated sessions from the shared database. List metadata/previews or supply a revision to retrieve one historical body. Missing ancestors are reported, not invented.",
		parameters: Type.Object({
			scope: Type.Optional(Type.Union([Type.Literal("branch"), Type.Literal("session")])),
			revision: Type.Optional(Type.String({ minLength: 1 })),
			before: Type.Optional(Type.String({ minLength: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		}),
		outputSchema: Result,
		executionMode: "sequential",
		annotations: { readOnlyHint: true, openWorldHint: false },
		execute: async (_id, params, _signal, _update, ctx) => result(() => controller.history(ctx, params)),
	});

	pi.registerTool({
		name: "register_restore",
		label: "Restore Register",
		namespace: Namespace,
		description:
			"Restore a historical revision as a new current candidate. Supply base_revision and a historical revision from this session or explicitly imported history. Preserves intervening revisions and does not roll back conversation or project files. Adoption occurs at the turn boundary.",
		parameters: Type.Object({ base_revision: Base, revision: Type.String({ minLength: 1 }) }),
		outputSchema: Result,
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		execute: async (_id, params, _signal, _update, ctx) =>
			result(() => controller.restore(ctx, params.base_revision, params.revision)),
	});

	pi.registerCommand("register", {
		description: "View the current Register.",
		handler: async (args, ctx) => controller.command(args, ctx),
	});
	return controller;
}
