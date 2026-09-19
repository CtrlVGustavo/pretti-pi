import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { MANAGED_WORKTREES_DIRECTORY } from "./worktree-paths.ts";

export interface WorktreeEntry {
	path: string;
	head: string;
	branch?: string;
	bare: boolean;
	detached: boolean;
	locked: boolean;
	prunable: boolean;
}

export const RMWORKTREE_USAGE = "Usage: /rmworktree [worktree] (quote paths containing spaces)";

export function parseRemovalArgs(args: string): string | undefined {
	const input = args.trim();
	if (!input) return undefined;
	let value = "";
	let quote = "";
	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		if (character === "\\" && quote !== "'") {
			if (++index === input.length) throw new Error(RMWORKTREE_USAGE);
			value += input[index];
		} else if (quote) {
			if (character === quote) quote = "";
			else value += character;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (/\s/.test(character)) {
			throw new Error(RMWORKTREE_USAGE);
		} else {
			value += character;
		}
	}
	if (quote || !value || value.startsWith("--")) throw new Error(RMWORKTREE_USAGE);
	return value;
}

// Keep all registrations, including unusable entries, so filtering cannot change
// which checkout is main or silently resolve an otherwise ambiguous name.
export function parseWorktrees(output: string): WorktreeEntry[] {
	return output.split("\0\0").filter(Boolean).map((record) => {
		const entry: WorktreeEntry = {
			path: "", head: "", bare: false, detached: false, locked: false, prunable: false,
		};
		for (const field of record.split("\0")) {
			if (field.startsWith("worktree ")) entry.path = field.slice("worktree ".length);
			else if (field.startsWith("HEAD ")) entry.head = field.slice("HEAD ".length);
			else if (field.startsWith("branch ")) entry.branch = field.slice("branch ".length);
			else if (field === "bare") entry.bare = true;
			else if (field === "detached") entry.detached = true;
			else if (field === "locked" || field.startsWith("locked ")) entry.locked = true;
			else if (field === "prunable" || field.startsWith("prunable ")) entry.prunable = true;
		}
		return entry;
	}).filter((entry) => entry.path);
}

export function branchName(worktree: WorktreeEntry): string {
	return worktree.branch?.startsWith("refs/heads/")
		? worktree.branch.slice("refs/heads/".length)
		: worktree.detached ? `(detached ${worktree.head.slice(0, 8)})` : "(no branch)";
}

function isInside(parent: string, candidate: string): boolean {
	const suffix = relative(parent, candidate);
	return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export function assertManagedWorktree(mainPath: string, worktree: WorktreeEntry): void {
	const managedPath = join(realpathSync(mainPath), MANAGED_WORKTREES_DIRECTORY);
	let allowed = false;
	try {
		// Reject a redirected .worktrees root as well as escapes through child symlinks.
		allowed = !worktree.bare && !worktree.prunable &&
			realpathSync(managedPath) === managedPath && isInside(managedPath, realpathSync(worktree.path));
	} catch {
		// Missing or inaccessible paths are never removal candidates.
	}
	if (!allowed) {
		throw new Error(`/rmworktree only removes existing linked worktrees inside ${managedPath}: ${worktree.path}`);
	}
}

export function managedWorktrees(worktrees: WorktreeEntry[]): WorktreeEntry[] {
	const main = worktrees[0];
	if (!main || main.bare) return [];
	return worktrees.slice(1).filter((worktree) => {
		try {
			assertManagedWorktree(main.path, worktree);
			return true;
		} catch {
			return false;
		}
	});
}

function targetPath(target: string, cwd: string): string {
	const expanded = target === "~" ? homedir() : target.startsWith("~/") ? join(homedir(), target.slice(2)) : target;
	const path = resolve(cwd, expanded);
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function matchingWorktrees(target: string, cwd: string, worktrees: WorktreeEntry[]): WorktreeEntry[] {
	const pathOnly = isAbsolute(target) || /^(\.\.?|~)(\/|$)/.test(target);
	const path = targetPath(target, cwd);
	return worktrees.filter((worktree) =>
		targetPath(worktree.path, cwd) === path || (!pathOnly && (
			worktree.branch === `refs/heads/${target}` || basename(worktree.path) === target
		)),
	);
}

export function resolveRemovalTarget(target: string, cwd: string, worktrees: WorktreeEntry[]): WorktreeEntry {
	const matches = matchingWorktrees(target, cwd, worktrees);
	if (matches.length === 0) throw new Error(`Unknown worktree: ${target}. Use an exact branch, directory name, or registered path.`);
	if (matches.length > 1) {
		throw new Error(`Ambiguous worktree: ${target}. Specify a path:\n${matches.map((entry) => entry.path).join("\n")}`);
	}
	if (matches[0] === worktrees[0]) throw new Error("The main worktree cannot be removed");
	assertManagedWorktree(worktrees[0].path, matches[0]);
	return matches[0];
}

function quoteTarget(target: string): string {
	return /[\s"'\\]/.test(target) ? `"${target.replace(/["\\]/g, "\\$&")}"` : target;
}

export function removalCompletions(prefix: string, cwd: string, worktrees: WorktreeEntry[]): AutocompleteItem[] | null {
	let query = prefix.trimStart();
	try {
		query = parseRemovalArgs(query) ?? "";
	} catch {
		// Continue suggesting while the user is typing a quoted path.
		if (query.startsWith('"') || query.startsWith("'")) query = query.slice(1);
		else return null;
	}
	const items = managedWorktrees(worktrees).flatMap((worktree) => {
		const branch = worktree.branch?.startsWith("refs/heads/") ? branchName(worktree) : undefined;
		const relativePath = relative(cwd, worktree.path);
		const homePath = isInside(homedir(), worktree.path) ? `~/${relative(homedir(), worktree.path)}` : undefined;
		const names = [branch, basename(worktree.path), worktree.path, relativePath, `./${relativePath}`, homePath]
			.filter((name): name is string => Boolean(name));
		if (!names.some((name) => name.startsWith(query))) return [];
		const name = [branch, basename(worktree.path)].find((candidate) => {
			if (!candidate || candidate.startsWith("--")) return false;
			const matches = matchingWorktrees(candidate, cwd, worktrees);
			return matches.length === 1 && matches[0] === worktree;
		});
		return [{
			value: quoteTarget(name ?? worktree.path),
			label: branch ?? basename(worktree.path),
			description: `${worktree.path}${worktree.detached ? " [detached]" : ""}${worktree.locked ? " [locked]" : ""}`,
		}];
	});
	return items.length ? items : null;
}
