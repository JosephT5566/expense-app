---
name: implement-from-issue
description: Implement an `ai-ready` expense-app issue on an isolated branch, run the required checks, and open an evidence-backed PR. Use when the user points at an ai-ready issue number or asks to implement it.
---

# Implement from issue

1. Check the issue has the `ai-ready` label and a complete approval checklist. If not, stop and use issue-enhance. If the issue changed after approval, stop and ask.
2. Read the acceptance criteria, decision log, selected design, and the context files AGENTS.md routes to for this area.
3. Check dependencies and overlapping open issues or PRs. Create `issue-<number>-<slug>`, in a worktree when another task is running.
4. Implement only the agreed scope. Follow nearby Svelte and store patterns. Trace mutations through fetchers, stores, and caches.
5. Run the checks the AGENTS.md Validation table requires for this change type, and report the real commands and results. Do not claim a check passed that was not run, and do not fix unrelated failures. For UI behavior changes, also use the `verify` skill and attach its evidence.
6. Update README, docs/architecture.md, or docs/database.md when documented behavior changed, using expense-app-guide.
7. Open a PR that references the issue, using `.github/pull_request_template.md`: summary, acceptance criteria checklist, commands run with results, screenshots for UI, risks, and what remains unverified (distinguish repository-verified, operator-reported, unverified).
8. Comment the PR link and status on the issue. Do not merge.
