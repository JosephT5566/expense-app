---
name: expense-app-guide
description: Explain JoPie's architecture and trace expense workflows. Maintain related project Markdown when code or configuration changes affect app structure, behavior, data contracts, setup, or validation.
---

# Expense app guide

Use this skill within the JoPie repository to explain the app, locate implementation, and maintain its documentation.

## Documentation routing

Paths below are relative to this skill directory; source paths in the documents are relative to the repository root. Read only relevant documents. A change can affect several documents.

| Task or changed area                                                              | Consult and update when affected                            |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Purpose, features, setup, environment, scripts, CI, deployment                    | [README.md](../../../README.md)                             |
| Routes, components, stores, fetchers, caching, auth, styling, PWA                 | [Architecture](../../../docs/architecture.md)               |
| Row types, Supabase queries, shares, settlement, scheduled lifecycle, receipt API | [Database and service contracts](../../../docs/database.md) |
| Agent workflow or documentation ownership                                         | [AGENTS.md](../../../AGENTS.md) and this skill              |

## Explain or plan a change

Trace the relevant route/component through stores, fetchers, types, and caches in current source. Use documentation as a navigation map, then confirm claims against implementation. Cite concrete repository paths.

Database policies, triggers, views, and the receipt backend are external. Distinguish frontend contracts, inherited notes, and externally verified definitions. Comments and mocks alone do not establish runtime behavior.

## Maintain documentation alongside changes

1. Review the task's code/configuration diff, including added, moved, and removed files. Identify descriptions that become inaccurate or incomplete.
2. Update only affected sections. Describe final behavior and responsibilities; remove obsolete paths and claims. Align setup commands and environment contracts with their actual consumers and configuration.
3. Keep each fact in its owning document and link to it elsewhere. Add a focused document only when warranted, then link it from the README and extend this routing table if needed.
4. Check Markdown links and source references, inspect the documentation diff for contradictions, and check changed-file formatting. When this skill changes, run skill-creator's `quick_validate.py` if available; otherwise inspect frontmatter and references directly.
5. Briefly report documentation updates and material uncertainty at completion. If documentation is unaffected, leave it unchanged.

Documentation maintenance accompanies the authorized task; it does not authorize deployment, live database changes, paid service calls, or unrelated application fixes. If documentation and code disagree outside the task, record the discrepancy without silently expanding implementation scope.
