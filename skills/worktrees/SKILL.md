---
name: worktrees
description: Use when creating, deleting, or merging Git worktrees.
---

# Worktrees

- Store new worktrees in `<main-worktree>/.worktrees/<branch>`.
- Find the main checkout with `git worktree list --porcelain`; do not assume it is the current directory.
- When deleting or merging, use the registered worktree path. `/rmworktree [worktree]` only removes worktrees inside the main checkout's `.worktrees/`; outside worktrees remain supported for resuming and merging.
- Keep `/.worktrees/` excluded through the shared Git `info/exclude`, not tracked `.gitignore`.
