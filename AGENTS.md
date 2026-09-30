# Repository instructions

## Browser automation

- For browser automation, use the Chrome plugin through its `browser-client` runtime by default.
- Do not use standalone Chrome DevTools MCP tools unless the user explicitly requests Chrome DevTools MCP or the Chrome plugin is unavailable.
- Continue to prefer purpose-built connectors, APIs, and CLIs when they are the appropriate tool for the task.

## Project documentation

- Use [expense-app-guide](.agents/skills/expense-app-guide/SKILL.md) when explaining the app's structure or planning changes across its modules.
- For every code or configuration change, assess whether documented behavior, structure, data contracts, setup, or validation commands changed. If so, read that skill and update the affected Markdown files in the same task before reporting completion.
- Changes that do not affect documentation, such as a style adjustment or an internal refactor preserving documented responsibilities and behavior, do not require a documentation edit.
- Keep project facts in [README.md](README.md), [Architecture](docs/architecture.md), and [Database and service contracts](docs/database.md). Keep the skill focused on how to consult and maintain them.
- Verify descriptions against source code. Database migrations and the receipt-analysis backend are not checked into this repository; distinguish unverified external details from confirmed implementation.

## Validation

Use the commands in [README.md](README.md) as appropriate to the change. For documentation-only work, validate links, source references, formatting, and skill metadata; an application build or E2E run is unnecessary unless executable behavior also changed.
