import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readTodoFile, safeText } from "../todo/core.ts";
import { PLAN_HELP, buildPlanPrompt, parsePlanCommand, planCompletions, todoSelectorPrefix } from "./core.ts";

export default function planExtension(pi: ExtensionAPI) {
	let completionContext: ExtensionContext | undefined;
	let generation = 0;
	pi.on("session_start", (_event, ctx) => { generation++; completionContext = ctx; });
	pi.on("session_shutdown", () => { generation++; completionContext = undefined; });

	pi.registerCommand("plan", {
		description: "Create a plan: /plan <request> | --todo <slug> | --todo --all | --help",
		getArgumentCompletions: async (prefix) => {
			const ctx = completionContext;
			if (!ctx || ctx.mode !== "tui") return null;
			const current = generation;
			try {
				const selector = todoSelectorPrefix(prefix);
				// Flags and free-form requests don't need disk access. Slugs always use fresh contents.
				const source = selector !== null && !selector.startsWith("--")
					? await readTodoFile(resolve(ctx.cwd, "TODO.md")) : null;
				return current === generation ? planCompletions(source, prefix) : null;
			} catch {
				// Don't interrupt typing; execution reports file and metadata errors.
				return null;
			}
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("/plan requires Pi's interactive TUI or RPC mode.");
			const current = generation;
			try {
				const command = parsePlanCommand(args);
				if (command.kind === "help") {
					ctx.ui.notify(PLAN_HELP, "info");
					return;
				}
				const source = command.kind === "request" ? null : await readTodoFile(resolve(ctx.cwd, "TODO.md"));
				if (current !== generation) return;
				const prompt = buildPlanPrompt(command, source);
				// The composed message is literal, not another slash command or template invocation.
				const queued = !ctx.isIdle();
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				if (queued) ctx.ui.notify("Plan queued as a follow-up.", "info");
			} catch (error) {
				if (current === generation) ctx.ui.notify(safeText(error instanceof Error ? error.message : String(error)), "error");
			}
		},
	});
}
