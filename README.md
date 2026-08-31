# pretti-pi

My personal setup for [Pi Coding Agent](https://github.com/earendil-works/pi).

## What's included

| Feature | What it adds |
| --- | --- |
| **Worktree commands** | `/commit`, `/addworktree`, `/worktrees`, `/rmworktree`, and `/mergeworktree` for managing parallel Git work from Pi. |
| **OpenAI web search** | A `web_search` tool backed by the OpenAI Responses API, with citations, batching, filters, and credential redaction. |
| **Planning prompt** | `/plan <request>` asks Pi to create a reviewable plan without implementing it. |

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
| `/addworktree <branch>` | Creates or reuses a branch in a sibling `<repository>-worktrees/` directory and continues the current Pi session there. |
| `/worktrees` | Searches worktrees and their Pi sessions, then resumes the selected session. Supports fuzzy terms, quoted phrases, and `re:` regular expressions. |
| `/rmworktree` | Removes a linked worktree after confirmation while retaining its branch. |
| `/mergeworktree [--manual]` | Commits pending work, merges it into the main worktree's branch, and cleans up the linked worktree and merged branch. |

> [!WARNING]
> `/rmworktree` force-removes the selected worktree. Its uncommitted, untracked, and ignored files are permanently deleted after confirmation.

By default, `/mergeworktree` hands merge conflicts to the active agent for resolution. Pass `--manual` to leave conflicts unresolved for manual handling.

See [the worktree command documentation](extensions/worktree-commands/README.md) for detailed behavior and recovery rules.

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
├── openai-web-search/   # web_search implementation and configuration
└── worktree-commands/   # Git commit and worktree slash commands
prompts/
└── plan.md              # Plan-only prompt template
test/
└── openai-web-search/   # web-search tests
```
## License

Licensed under the MIT License.
