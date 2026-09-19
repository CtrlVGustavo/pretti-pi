import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { positiveInteger } from "./core.ts";

export interface EditorTarget {
	path: string;
	cwd: string;
	line: number;
	column: number;
}

export interface EditorExit {
	status: number | null;
	signal: string | null;
	error?: string;
}

interface TerminalUI {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

interface HandoffDependencies {
	spawn: typeof spawnSync;
	write: (text: string) => void;
}

export function neovimArgs(target: EditorTarget): string[] {
	if (!positiveInteger(target.line) || !positiveInteger(target.column) || target.path.includes("\0")) {
		throw new Error("Invalid Neovim target.");
	}
	// Only validated numbers appear in Ex commands. The path is a literal argument,
	// never interpolated into shell, Ex, or Lua code. -- also protects option-like paths.
	return [`+call cursor(${target.line},${target.column})`, "+normal! zz", "--", target.path];
}

/** Synchronous handoff follows Pi's interactive-shell example: no Pi renders while nvim owns the TTY. */
export function runNeovim(
	tui: TerminalUI,
	target: EditorTarget,
	dependencies: HandoffDependencies = { spawn: spawnSync, write: (text) => { process.stdout.write(text); } },
): EditorExit {
	const args = neovimArgs(target);
	try {
		tui.stop();
		dependencies.write("\x1b[2J\x1b[H");
		const result = dependencies.spawn("nvim", args, {
			cwd: target.cwd, stdio: "inherit", shell: false, env: process.env,
		});
		return {
			status: result.status, signal: result.signal,
			error: result.error ? ((result.error as NodeJS.ErrnoException).code === "ENOENT"
				? "Neovim was not found. Install nvim and make it available on PATH."
				: result.error.message) : undefined,
		};
	} catch (error) {
		return { status: null, signal: null, error: error instanceof Error ? error.message : String(error) };
	} finally {
		// Restore even if spawn fails or the child is killed; ui.custom restores the prompt draft.
		try {
			dependencies.write("\x1b[0m\x1b[?25h");
		} finally {
			tui.start();
			tui.requestRender(true);
		}
	}
}

export async function openInNeovim(ctx: ExtensionContext, target: EditorTarget): Promise<EditorExit> {
	if (ctx.mode !== "tui" || !process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("Opening Neovim requires Pi's interactive TUI in a terminal.");
	}
	return ctx.ui.custom<EditorExit>((tui, _theme, _keybindings, done) => {
		const result = runNeovim(tui, target);
		done(result);
		return { render: () => [], invalidate() {} };
	});
}
