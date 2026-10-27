# Agent workflow

Issue-first development for JoPie. Rules live in [AGENTS.md](../AGENTS.md#issue-first-workflow); each stage is a skill under `.agents/skills/`. GitHub Issues and PRs are the durable record, not chat.

## Flow

1. Capture: open a raw issue from the `[idea]` template.
2. Enhance: `issue-enhance` asks the material questions and rewrites the issue as a spec.
3. Design gate: for UI changes, `ui-design-gate` produces 2-3 options and the owner selects one.
4. Approve: the owner confirms the spec; the `ai-ready` label is added.
5. Implement: `implement-from-issue` works on branch `issue-<number>-<slug>` and opens a PR.
6. Review: `review-pr` runs in a session that did not write the code.
7. Merge: the owner merges after required checks pass. Agents never merge.

Owner approval is also required for the high-risk areas listed in AGENTS.md.

## Starting each stage

Say one of these to the agent. Replace the number.

| Stage                 | Prompt                                                                             |
| --------------------- | ---------------------------------------------------------------------------------- |
| Capture and enhance   | `Use issue-enhance on #12.` or `Create an issue for <idea> and use issue-enhance.` |
| UI design             | `Use ui-design-gate on #12.`                                                       |
| Implement             | `Use implement-from-issue on #12.`                                                 |
| Verify in the browser | `Use verify to check <flow>.`                                                      |
| Review                | `Use review-pr on PR #15. You did not write it.`                                   |

Prompts only name the skill and the issue. Rules stay in AGENTS.md and the skills so they cannot drift between copies.

## Status

Status is the issue label plus its state: `[idea]` raw, `ai-ready` approved, PR open means in review, closed means done. Labels are not a lock. If two agents could claim the same issue, comment on it before starting and check for an existing branch.

## Not automated

Nothing here starts by itself. Branch protection, required CI checks, and CODEOWNERS enforce what AGENTS.md only asks for.
