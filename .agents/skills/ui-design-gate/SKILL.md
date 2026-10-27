---
name: ui-design-gate
description: Produce 2-3 distinct UI options for an expense-app change and record the owner's selection in the issue before any UI code is written. Use for any change to layout, visual design, copy hierarchy, or interaction.
---

# UI design gate

1. Read the existing components, shadcn-ui usage, design tokens, and the Traditional Chinese copy in the affected route. Note mobile-first constraints.
2. Produce 2-3 meaningfully different options with the `frontend-design` skill. Prefer previews that run (a static HTML file or a Svelte route behind a throwaway branch) over images. Never commit previews to `master`.
3. Compare them: visual hierarchy, mobile behavior, accessibility, complexity, impact on stores and caches.
4. Ask the owner to select or request revisions. No implementation before selection. Do not recommend a winner as if decided.
5. Record the selected option, preview links or screenshots, and the reasons in the issue's "UI design selection" section, and add a matching acceptance criterion.

If the change is purely non-visual, skip the gate and write one line in the issue saying why.
