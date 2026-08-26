# OpenAI web search

This extension adds a `web_search` tool backed by OpenAI's Responses API `web_search` capability. It returns a synthesized answer followed by source links and snippets.

## Usage

The agent can call the tool with one query:

```typescript
web_search({ query: "Node.js permission model documentation" })
```

Or with up to eight queries, which are run sequentially:

```typescript
web_search({
  queries: ["React 19 changes", "React 19 migration guide"]
})
```

Available parameters:

- `query` — one non-empty query. Used when `queries` is omitted or empty.
- `queries` — up to eight queries; takes precedence over `query`.
- `numResults` — preferred number of distinct sources, from 1 to 20.
- `recencyFilter` — prefer results from the last `day`, `week`, `month`, or `year`.
- `domainFilter` — allowed domains; prefix a domain with `-` to block it.

For example:

```typescript
web_search({
  query: "TypeScript releases",
  numResults: 5,
  recencyFilter: "month",
  domainFilter: ["typescriptlang.org", "-example.com"]
})
```

When a batch contains both successful and failed queries, the tool returns the successful results and reports the failures separately. It fails only if every query fails.

## Authentication

Authentication is resolved in this order:

1. Pi model-registry credentials for `openai-codex` or `openai`, including credentials established with `/login`.
2. `OPENAI_API_KEY` or the configured `openaiApiKey` source.

This means a Codex subscription login normally works without a separate API key.

## Configuration

Configuration is read from `web-search.json` in the first applicable Pi configuration directory:

- `$PI_CODING_AGENT_DIR/web-search.json`
- `$XDG_CONFIG_HOME/pi/web-search.json`
- `~/.pi/web-search.json`

Example:

```json
{
  "openaiApiKey": "$OPENAI_API_KEY",
  "openaiResponsesUrl": "https://api.openai.com/v1/responses",
  "openaiSearchModel": "gpt-5.6-terra"
}
```

Configuration fields:

- `openaiApiKey` — a literal credential, an environment reference such as `$OPENAI_API_KEY`, or a trusted shell command prefixed with `!`.
- `openaiResponsesUrl` — an absolute HTTPS Responses API endpoint for OpenAI API-key requests. Plain HTTP is rejected to prevent sending bearer credentials over an unencrypted connection.
- `openaiSearchModel` — a model ID override. Without one, the extension selects an available OpenAI search model or defaults to `gpt-5.6-terra` for API-key authentication.

Credential commands execute with the current user's permissions and must only contain trusted commands. Likewise, configure only trusted custom endpoints because they receive the resolved bearer credential and search requests. Codex credentials use the Codex Responses endpoint regardless of `openaiResponsesUrl`.

## Limits and cleanup

- Each search has a 60-second timeout and honors Pi cancellation.
- Tool output is limited to Pi's default 50 KB or 2,000 lines.
- Complete truncated output is written to a private temporary Markdown file and removed when the session shuts down.
- Credentials are redacted from provider error messages.

## Development

From the package root, run:

```bash
npm run test:web-search
npm run typecheck:web-search
```
