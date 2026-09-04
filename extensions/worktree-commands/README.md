# Worktree commands

This extension group adds five slash commands for committing changes and creating, resuming, removing, and merging Git worktrees.

## `/commit [context]`

Stages every change in the current checkout, uses the active model to generate a concise subject and detailed description, and commits to the checked-out branch. Optional text provides additional context for the commit message. Before staging, it refuses to continue if a linked worktree is nested inside the checkout but is tracked or not effectively ignored.

```text
/commit
/commit explain that this fixes the startup race
```

## `/addworktree <branch>`

Creates a linked Git worktree for the required branch name and continues the current Pi session in it. Existing local branches are reused; otherwise, a branch is created from `HEAD`.

New worktrees are stored at `<main-worktree>/.worktrees/<branch>`, including when the command is run from another linked worktree. Existing worktrees in other locations remain supported. If necessary, the command initializes the repository and creates an initial commit before adding the worktree.

The command adds `/.worktrees/` to the repository-local `.git/info/exclude`. This keeps nested checkouts out of Git status and `/commit` without changing the tracked `.gitignore`. It refuses to use `.worktrees` if the path is tracked, if an existing directory is not already ignored, or if a higher-precedence `.gitignore` rule prevents the exclusion from taking effect.

Tools that do not honor Git exclusions may still scan the nested checkouts. Also, `git clean -ffdx` can delete the entire `.worktrees` directory and every worktree inside it.

Examples:

```text
/addworktree feature/my-change
```

## `/worktrees`

Opens an interactive picker containing the current repository's usable worktrees and their Pi sessions. Select a session to resume it, or select a worktree without sessions to create a new session there.

Search supports fuzzy terms, quoted exact phrases, and case-insensitive regular expressions prefixed with `re:`. It searches worktree details and session metadata and message text.

```text
/worktrees
```

This command requires Pi's interactive TUI mode.

## `/rmworktree`

Abandons a linked worktree without deleting its branch. The worktree folder and Git registration are removed with force, so all uncommitted, untracked, and ignored files in it are permanently deleted after confirmation.

When run from a linked worktree, Pi first switches the current session to the repository's main worktree and then removes the old worktree. The removal is cancelled if the session switch is cancelled.

When run from the main worktree, an interactive picker lists the repository's linked worktrees. Select one and confirm its removal. This selection flow requires Pi's interactive TUI mode.

```text
/rmworktree
```

## `/mergeworktree [--manual]`

Run this from a linked worktree to merge its branch into the branch checked out in the main worktree. Both worktrees must be attached to local branches, and the main worktree must be clean.

If the linked worktree has uncommitted changes, Pi stages and commits all of them using the same model-generated commit flow as `/commit` before merging.

After a successful merge, Pi switches to a session in the main worktree, removes the linked worktree, and safely deletes its merged branch.

By default, merge conflicts are handed to the active agent in the main worktree for automatic resolution. The command verifies and commits a completed resolution before cleanup. If resolution fails, it retains the unfinished merge, source worktree, and branch for recovery.

With `--manual`, conflicts are left unresolved. Pi summarizes the available conflict data and waits for instructions without editing, staging, committing, or aborting the merge.

Examples:

```text
/mergeworktree
/mergeworktree --manual
```
