---
name: review-pr
description: Independently review an expense-app pull request against its issue's acceptance criteria and the repository's risk rules. Use when asked to review a PR, from a session that did not write it.
---

# Review PR

1. Read the linked issue first, then the diff. Do not rely on the PR description's claims.
2. Check: every acceptance criterion has evidence; changed files stay in scope; failure paths; the documented Taiwan date and money rules; Pages base path and OAuth redirects when routing changed; docs updated when behavior changed.
3. Re-run or inspect CI for the checks the Validation table requires. Mocked tests do not verify RLS, deployed services, or atomicity; say what still needs external verification.
4. Mark as needing owner approval any change in the AGENTS.md owner-approval list.
5. Post findings as review comments, ordered by severity, each with file and line. Use COMMENT only. Leave approve or request-changes and merging to the owner.
