import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	EMPTY_TODO, MAX_FILE_BYTES, TODO_ENTRY_TYPE, parseTodoCommand, readTodoFile, safeText, todoCompletions, transformTodo,
} from "./core.ts";

export default function todoExtension(pi: ExtensionAPI) {
	let completionContext: ExtensionContext | undefined;
	let generation = 0;
	pi.on("session_start", (_event, ctx) => { generation++; completionContext = ctx; });
	pi.on("session_shutdown", () => { generation++; completionContext = undefined; });

	pi.registerEntryRenderer<{ output: string; error?: boolean }>(TODO_ENTRY_TYPE, (entry, _options, theme) =>
		new Text(theme.fg(entry.data?.error ? "error" : "text", safeText(entry.data?.output ?? "TODO.md")), 0, 0));

	pi.registerCommand("todo", {
		description: "TODO.md: /todo [--all | --done | --cleardone | --check <slug> | <text>]",
		getArgumentCompletions: async (prefix) => {
			const ctx = completionContext;
			if (!ctx || ctx.mode !== "tui") return null;
			const current = generation;
			try {
				// Completion is read-only and reads current disk contents, not stale session state.
				const source = /^\s*--check[ \t]+/.test(prefix) ? await readTodoFile(resolve(ctx.cwd, "TODO.md")) : null;
				return current === generation ? todoCompletions(source, prefix) : null;
			} catch {
				// Don't interrupt typing with I/O/metadata errors; executing /todo reports them.
				return null;
			}
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") throw new Error("/todo requires Pi's interactive TUI or RPC mode.");
			const current = generation;
			try {
				const command = parseTodoCommand(args);
				const path = resolve(ctx.cwd, "TODO.md");
				const result = await withFileMutationQueue(path, async () => {
					if (current !== generation) throw new Error("Session changed before /todo could run.");
					let source = await readTodoFile(path);
					if (source === null) {
						try {
							// Never truncate a file created by another process in the meantime.
							await writeFile(path, EMPTY_TODO, { flag: "wx" });
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						}
						source = await readTodoFile(path);
						if (source === null) throw new Error("TODO.md disappeared. Please retry.");
					}
					const result = transformTodo(source, command);
					if (result.content !== source) {
						if (Buffer.byteLength(result.content) > MAX_FILE_BYTES) throw new Error("Updated TODO.md would exceed the 2 MiB size limit.");
						if (await readTodoFile(path) !== source) throw new Error("TODO.md changed while the command was running. Please retry.");
						if (current !== generation) throw new Error("Session changed before TODO.md could be updated.");
						await writeFile(path, result.content, "utf8");
					}
					return result;
				});
				if (current !== generation) return;
				const data = { output: safeText(result.output), error: result.error };
				if (ctx.mode === "tui") pi.appendEntry(TODO_ENTRY_TYPE, data);
				else ctx.ui.notify(data.output, data.error ? "error" : "info");
			} catch (error) {
				if (current === generation) ctx.ui.notify(safeText(error instanceof Error ? error.message : String(error)), "error");
			}
		},
	});
}
