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

New worktrees are stored at `<main-worktree>/.worktrees/<branch>`, including when the command is run from another linked worktree. Existing worktrees in other locations remain supported for resuming and merging, but cannot be removed with `/rmworktree`. If necessary, the command initializes the repository and creates an initial commit before adding the worktree.

The command adds `/.worktrees/` to the repository-local `.git/info/exclude`. This keeps nested checkouts out of Git status and `/commit` without changing the tracked `.gitignore`. It refuses to use `.worktrees` if the path is tracked, if an existing directory is not already ignored, or if a higher-precedence `.gitignore` rule prevents the exclusion from taking effect.

Tools that do not honor Git exclusions may still scan the nested checkouts. Also, `git clean -ffdx` can delete the entire `.worktrees` directory and every worktree inside it.

Examples:

```text
/addworktree feature/my-change
```

## `/worktrees [--list]`

Without arguments, opens an interactive picker containing the current repository's usable worktrees and their Pi sessions. Select a session to resume it, or select a worktree without sessions to create a new session there.

Search supports fuzzy terms, quoted exact phrases, and case-insensitive regular expressions prefixed with `re:`. It searches worktree details and session metadata and message text.

Pass `--list` to print each usable worktree's branch, full path, and applicable status labels without indexing sessions or opening the picker.

```text
/worktrees
/worktrees --list
```

The interactive picker requires Pi's TUI mode; list mode is also available through RPC.

## `/rmworktree [worktree]`

Abandons a registered linked worktree **inside `<main-worktree>/.worktrees/`** without deleting its branch. The worktree folder and Git registration are removed with force, so all uncommitted, untracked, and ignored files in it are permanently deleted after confirmation.

The optional positional target accepts an exact branch name, unique directory name, or registered worktree path (absolute or relative to the current working directory). Quote paths containing spaces. Unknown or ambiguous targets are rejected; use an explicit path to disambiguate. There are no flags.

Type `/rmworktree ` to autocomplete eligible worktrees, then type a prefix to filter suggestions. Suggestions show names and paths, and insert an unambiguous target. The main checkout and outside, missing, or prunable worktrees are never offered.

Without a target, running from a linked worktree removes the current worktree; running from the main checkout opens a picker of eligible worktrees. The picker requires Pi's interactive TUI mode.

Removing the current worktree first switches the session to the main checkout; cancelling the switch cancels removal. Removing another worktree leaves the current session and checkout unchanged. Confirmation is always required (TUI or RPC).

The `.worktrees/` restriction applies to explicit targets, the picker, and no-argument removal. Nested paths such as `.worktrees/feature/login` are supported. Canonical paths are checked again before deletion; symlink escapes and redirected `.worktrees` roots are rejected.

```text
/rmworktree
/rmworktree feature/login
/rmworktree ./.worktrees/feature/login
/rmworktree "/path/to/repo/.worktrees/review copy"
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
