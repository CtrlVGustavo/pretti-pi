import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import addWorktreeExtension from "./addworktree.ts";
import commitExtension from "./commit.ts";
import mergeWorktreeExtension from "./mergeworktree.ts";
import rmWorktreeExtension from "./rmworktree.ts";
import worktreesExtension from "./worktrees.ts";

export default function worktreeCommandsExtension(pi: ExtensionAPI) {
	addWorktreeExtension(pi);
	commitExtension(pi);
	mergeWorktreeExtension(pi);
	rmWorktreeExtension(pi);
	worktreesExtension(pi);
}
