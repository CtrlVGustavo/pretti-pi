# pretti-pi

My personal setup for [Pi Coding Agent](https://github.com/earendil-works/pi).

## What's included

| Feature | What it adds |
| --- | --- |
| **Worktree commands** | `/commit`, `/addworktree`, `/worktrees`, `/rmworktree`, and `/mergeworktree` for managing parallel Git work from Pi. |
| **OpenAI web search** | A `web_search` tool backed by the OpenAI Responses API, with citations, batching, filters, and credential redaction. |
| **Plan command** | `/plan <request>` or `/plan --todo <slug>` creates a reviewable plan, with unchecked TODO completion and `--all` support. |
| **Code cards** | Syntax-highlighted previews, readable slugs, `/code --file` fuzzy file completion, and user-controlled Neovim editing. |
| **Todo command** | `/todo` lists, adds, checks, and clears tasks in `TODO.md`, with stable slugs and completion. |

## Installation

Install the package directly from GitHub:

```bash
pi install git:github.com/CtrlVGustavo/pretti-pi
```

To pin the installation, append a release tag or commit—for example:

```bash
pi install git:github.com/CtrlVGustavo/pretti-pi@v0.1.0
```

Pi installs the package's dependencies and discovers its extensions and prompts through `package.json`. Restart Pi after installation, or use `/reload` after updating package resources during development.

### Local development installation

Clone the repository, install its development dependencies, and point Pi at the checkout:

```bash
git clone https://github.com/CtrlVGustavo/pretti-pi.git
cd pretti-pi
npm install
pi install "$PWD"
```

Pi references a local installation in place, so source changes are available after `/reload`.

## Worktree workflow

The worktree commands provide a complete workflow for parallel changes:

```text
/addworktree feature/my-change
# Work in the linked worktree with Pi
/commit optional context for the commit message
/mergeworktree
```

| Command | Description |
| --- | --- |
| `/commit [context]` | Stages all changes and asks the active model to create a concise subject and detailed commit description. |
| `/addworktree <branch>` | Creates or reuses a branch under the main checkout's `.worktrees/` directory and continues the current Pi session there. |
| `/worktrees [--list]` | Searches worktrees and their Pi sessions, then resumes the selected session. Use `--list` to print the worktrees without opening the picker. Supports fuzzy terms, quoted phrases, and `re:` regular expressions. |
| `/rmworktree [worktree]` | Removes a linked worktree inside the main checkout's `.worktrees/` after confirmation, retaining its branch. Accepts an autocompleted name or path. |
| `/mergeworktree [--manual]` | Commits pending work, merges it into the main worktree's branch, and cleans up the linked worktree and merged branch. |

> [!WARNING]
> `/rmworktree` force-removes the selected worktree. Its uncommitted, untracked, and ignored files are permanently deleted after confirmation.

New worktrees are stored at `<main-worktree>/.worktrees/<branch>`. The command adds `/.worktrees/` to the repository-local `.git/info/exclude`, so the main branch does not track the nested checkouts and no `.gitignore` change is committed. Existing worktrees in other locations can still be resumed and merged, but `/rmworktree` only removes worktrees inside the main checkout's `.worktrees/`. Tools that do not honor Git exclusions may still scan `.worktrees/`, and `git clean -ffdx` can delete the entire directory.

By default, `/mergeworktree` hands merge conflicts to the active agent for resolution. Pass `--manual` to leave conflicts unresolved for manual handling.

See [the worktree command documentation](extensions/worktree-commands/README.md) for detailed behavior and recovery rules.

## Code cards

Ask Pi to show a code card for a file or snippet. Cards have a syntax-highlighted snapshot, a descriptive slug, and a short ID. Once Pi is idle, open one in Neovim:

```text
/code index-hash-detect
/code a101ca00
/code --file src/index.ts:42
```

Type `/code ` to see available cards, or type part of a slug or ID to filter suggestions. `/code` alone opens a picker; `/code --last` opens the most recent card or file. Completing a reference only fills the command—it does not open the editor.

Cards and their slugs persist across reloads and resumes. References and card suggestions are scoped to the current conversation branch. Slug collisions get numeric suffixes such as `index-hash-detect-2`. Older cards remain accessible by bare ID, and old `#id` commands still work. If a filename matches a card reference, use `--file` or an explicit path such as `./index-hash-detect`.

### Open a file without a card

Type `/code --file ` to see file suggestions, then type a fuzzy query (for example `srcidx` to find `src/index.ts`). Matching uses the full relative path, case-insensitively. Select a suggestion with Tab or the completion menu, then submit the completed command to open Neovim. Completion only fills the path; it never opens the editor or modifies files. Submitting a fuzzy query without completing it treats the query as a literal path.

```text
/code --file src/index.ts
/code --file "src/my file.ts":42:3
/code --file ~/notes.md
```

`--file` always selects a path, even when it matches a card slug, ID, or `--last`. Spaces are quoted automatically; double-quoted paths support escaped quotes (`\"`) and backslashes (`\\`). Optional line and column numbers are positive and 1-based (columns are Neovim byte columns). Relative paths resolve against Pi's current working directory. A bare `/code --file` displays a usage hint rather than another picker.

Project suggestions include tracked and untracked files beneath the current directory, including dotfiles, and honor Git ignore rules for untracked files. Absolute, `~/`, and `../` queries browse one directory at a time. Without a Git repository or Git executable, a bounded filesystem walk skips `.git`, `node_modules`, and `.worktrees`, without following directory symlinks; this fallback does not interpret ignore files. Discovery is asynchronous and cancellable, capped at 20,000 candidates, 4 MiB of Git output, and a two-second budget, with at most 20 suggestions. The fallback walk also stops below 20 directory levels. Explicit paths still work when a file is not suggested.

Direct file opening creates **no code card**. `/code --last` follows the most recent interaction: a newly shown card, an opened card, or an opened file (including the `/code src/index.ts:42` shorthand). This history persists across reloads/resumes and follows the active conversation branch. Cancelled interactions and editor launch failures do not replace it. Reopening a file uses its last requested line/column, clamping the line to the end if the file has become shorter; it does not restore old contents or track Neovim's final cursor position. Files must already exist and be regular UTF-8 text files up to 2 MiB; directories, binary files, and nonexistent files cannot be opened.

Opening a card uses the **current file**, not its preview snapshot. For both cards and direct files, `:wq` saves and returns to Pi; changes to the opened file are reported without automatically starting an assistant turn. Neovim (`nvim`) must be on `PATH`, and opening requires Pi to be idle in its interactive TUI.

Highlighting uses the active Pi theme and falls back to plain text for unknown languages or errors. It operates on the bounded preview, so snippets beginning inside multiline strings or comments may lack complete syntax context. Previews remain limited to 12 lines of 240 characters (plus an ellipsis when truncated); files must be UTF-8 text up to 2 MiB.

## Todo command

Manage `TODO.md` in Pi's current working directory without starting an assistant turn:

```text
/todo Fix login redirect
/todo
/todo --check fix-login-redirect
/todo --all
/todo --cleardone
```

| Command | Description |
| --- | --- |
| `/todo` | Show unchecked items and their slugs. |
| `/todo --all` | Show checked and unchecked items in file order. |
| `/todo --done` | Show only checked items in file order. |
| `/todo <text>` | Append one unchecked item; spaces need no quotes. |
| `/todo --check <slug>` | Check the exact matching item. Already checked items stay checked. |
| `/todo --cleardone` | Remove checked task lines, preserving notes and unchecked subtasks. |
| `/todo -- <text>` | Add literal text beginning with `--`. |

Type `/todo --check ` to autocomplete unchecked slugs; typing a slug prefix narrows the suggestions. Completion only fills the command, never executes it or modifies the file.

Listing creates a missing `TODO.md` and prints `TODO.md is empty.` Adding creates the file and adds the task immediately. No parent-directory search is performed, so each worktree has its own file. Results appear inline in Pi without entering model context; RPC clients receive notifications.

Tasks use normal Markdown checkboxes with stable slug comments:

```markdown
- [ ] Fix login redirect <!-- todo:fix-login-redirect -->
```

New slugs use the first three distinct keywords from the task, skipping common filler words such as “the”, “to”, and “please”. For example, “Fix the login redirect after logout” becomes `fix-login-redirect`. Generation is local and deterministic, with no model calls. Collisions get numeric suffixes such as `fix-login-redirect-2`; these numbers do not count toward the three-word limit.

Existing checkbox tasks receive missing slug comments on first use. Stored slugs—including older, longer ones—are preserved, and editing task text does not change them. The file is read afresh for every command, including completion.

See [the todo documentation](extensions/todo/README.md) for parsing, preservation, and error behavior.

## Plan command

Use `/plan` to request a reviewable plan without implementation:

```text
/plan I want to add a new feature.
/plan --todo fix-login-redirect Focus on regression tests.
/plan --todo --all Group related tasks into milestones.
/plan --help
```

| Command | Description |
| --- | --- |
| `/plan <request>` | Send the original planning instructions followed by the complete request. |
| `/plan --todo <slug> [extra text]` | Include the matching TODO task and optional additional instructions. |
| `/plan --todo --all [extra text]` | Include all **unchecked** tasks in file order, plus optional additional instructions. |
| `/plan -- <request>` | Treat the request literally, even if it starts with a flag. |
| `/plan --help` | Explain usage and every flag without starting an assistant turn. |

A bare `/plan` or `/plan --todo` reports an error explaining what to provide. `--all` is only valid after `--todo`; no unchecked tasks is an error. Requests and extra text can contain spaces and newlines without quotes.

Type `/plan --todo ` to autocomplete unchecked slugs or `--all`. Checked tasks are never suggested, but an explicitly typed checked slug is accepted. TODO lookup uses only the current directory's `TODO.md` and never modifies it. When busy, Pi queues the expanded prompt as a follow-up.

This command supplies planning instructions, not an enforced read-only mode. See [the plan documentation](extensions/plan/README.md) for prompt formatting, parsing, and error behavior.

## OpenAI web search

The `web_search` tool accepts one query or a sequential batch of up to eight queries:

```typescript
web_search({ query: "Node.js permission model documentation" })
web_search({ queries: ["React 19 changes", "React 19 migration guide"] })
web_search({
  query: "TypeScript releases",
  numResults: 5,
  recencyFilter: "month",
  domainFilter: ["typescriptlang.org", "-example.com"]
})
```

Available options:

- `query` — one non-empty query.
- `queries` — up to eight queries; takes precedence over `query`.
- `numResults` — preferred number of distinct sources, from 1 to 20.
- `recencyFilter` — prefer results from the last `day`, `week`, `month`, or `year`.
- `domainFilter` — allow domains, or prefix a domain with `-` to block it.

### Authentication

The extension first uses Pi model-registry credentials for `openai-codex` or `openai`, including credentials established through `/login`. It otherwise uses `OPENAI_API_KEY` or an `openaiApiKey` source in Pi's `web-search.json` configuration:

```json
{
  "openaiApiKey": "$OPENAI_API_KEY",
  "openaiResponsesUrl": "https://api.openai.com/v1/responses",
  "openaiSearchModel": "gpt-5.6-terra"
}
```

Custom Responses API endpoints must use HTTPS so bearer credentials are never sent over an unencrypted connection. See [the web-search documentation](extensions/openai-web-search/README.md) for configuration precedence, custom endpoints, limits, and credential-command safety.

## Project structure

```text
extensions/
├── code-cards/          # Code previews, references, and Neovim handoff
├── openai-web-search/   # web_search implementation and configuration
├── plan/               # Planning command, TODO selection, and help
├── todo/               # TODO.md slash command and slug completion
└── worktree-commands/   # Git commit and worktree slash commands
test/
├── code-cards/          # Card rendering, completion, and editor safety tests
├── openai-web-search/   # web-search tests
├── plan/               # Prompt composition, TODO lookup, and completion tests
├── todo/               # Task parsing, file operations, and completion tests
└── worktree-commands/   # worktree behavior and safety tests
```
## License

Licensed under the MIT License.
