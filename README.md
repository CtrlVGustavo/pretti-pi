# pretti-pi

My personal setup for [Pi Coding Agent](https://github.com/earendil-works/pi).

## What's included

| Feature | What it adds |
| --- | --- |
| **Worktree commands** | `/commit`, `/addworktree`, `/worktrees`, `/rmworktree`, and `/mergeworktree` for managing parallel Git work from Pi. |
| **OpenAI web search** | A `web_search` tool backed by the OpenAI Responses API, with citations, batching, filters, and credential redaction. |
| **Planning prompt** | `/plan <request>` asks Pi to create a reviewable plan without implementing it. |
| **Code cards** | Syntax-highlighted code previews with readable slugs, `/code` autocomplete, and user-controlled Neovim editing. |
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
/code src/index.ts:42
```

Type `/code ` to see available cards, or type part of a slug or ID to filter suggestions. `/code` alone opens a picker; `/code --last` opens the latest card. Completing a reference only fills the command—it does not open the editor.

Cards and their slugs persist across reloads and resumes. References and suggestions are scoped to the current conversation branch. Slug collisions get numeric suffixes such as `index-hash-detect-2`. Older cards remain accessible by bare ID, and old `#id` commands still work. If a filename matches a card reference, use an explicit path such as `./index-hash-detect`.

Opening a card uses the **current file**, not its preview snapshot. `:wq` saves and returns to Pi; changes to the opened file are reported without automatically starting an assistant turn. Neovim (`nvim`) must be on `PATH`, and opening cards requires Pi's interactive TUI.

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
| `/todo` or `/todo --unchecked` | Show unchecked items and their slugs. |
| `/todo --all` | Show checked and unchecked items in file order. |
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

## Planning prompt

Use `/plan` followed by an unquoted request to ask Pi for a plan without starting implementation:

```text
/plan I want to add a new feature.
```

The complete request is included in the expanded prompt, even when it contains spaces.

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
├── todo/                # TODO.md slash command and slug completion
└── worktree-commands/   # Git commit and worktree slash commands
prompts/
└── plan.md              # Plan-only prompt template
test/
├── code-cards/          # Card rendering, completion, and editor safety tests
├── openai-web-search/   # web-search tests
├── todo/                # Task parsing, file operations, and completion tests
└── worktree-commands/   # worktree behavior and safety tests
```
## License

Licensed under the MIT License.
