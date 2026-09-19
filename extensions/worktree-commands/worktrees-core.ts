import { existsSync } from "node:fs";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export interface WorktreeEntry {
	path: string;
	head: string;
	branch?: string;
	bare: boolean;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
	main: boolean;
	current: boolean;
	sessions?: SessionInfo[];
}

export type WorktreesCommandMode = "picker" | "list";

export const WORKTREES_USAGE = "Usage: /worktrees [--list]";

export function parseWorktreesCommandArgs(args: string): WorktreesCommandMode {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return "picker";
	}
	if (tokens.length === 1 && tokens[0] === "--list") {
		return "list";
	}
	throw new Error(WORKTREES_USAGE);
}

export function parseWorktrees(output: string): WorktreeEntry[] {
	return output
		.split("\0\0")
		.filter(Boolean)
		.map((record, index) => {
			const entry: WorktreeEntry = {
				path: "",
				head: "",
				bare: false,
				detached: false,
				locked: false,
				prunable: false,
				main: index === 0,
				current: false,
			};

			for (const field of record.split("\0")) {
				if (field.startsWith("worktree ")) {
					entry.path = field.slice("worktree ".length);
				} else if (field.startsWith("HEAD ")) {
					entry.head = field.slice("HEAD ".length);
				} else if (field.startsWith("branch ")) {
					entry.branch = field.slice("branch ".length);
				} else if (field === "bare") {
					entry.bare = true;
				} else if (field === "detached") {
					entry.detached = true;
				} else if (field === "locked" || field.startsWith("locked ")) {
					entry.locked = true;
				} else if (field === "prunable" || field.startsWith("prunable ")) {
					entry.prunable = true;
				}
			}

			return entry;
		})
		.filter((entry) => entry.path && !entry.bare && !entry.prunable && existsSync(entry.path));
}

export function branchName(worktree: WorktreeEntry): string {
	const prefix = "refs/heads/";
	if (worktree.branch?.startsWith(prefix)) {
		return worktree.branch.slice(prefix.length);
	}
	return worktree.detached ? `(detached ${worktree.head.slice(0, 8)})` : "(no branch)";
}

export function worktreeStatusLabels(worktree: WorktreeEntry): string[] {
	return [
		worktree.main ? "main" : "",
		worktree.current ? "current" : "",
		worktree.detached ? "detached" : "",
		worktree.locked ? "locked" : "",
	].filter(Boolean);
}

export function formatWorktreeList(worktrees: WorktreeEntry[]): string {
	const lines = worktrees.map((worktree) => {
		const labels = worktreeStatusLabels(worktree);
		const status = labels.length > 0 ? ` [${labels.join(", ")}]` : "";
		return `- ${branchName(worktree)}${status} — ${worktree.path}`;
	});
	return ["Worktrees:", ...lines].join("\n");
}
