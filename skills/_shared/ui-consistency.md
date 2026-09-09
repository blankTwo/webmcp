# UI Consistency Rules

## Goal
Every new or modified page must align with the existing project UI style before inventing a new visual direction.

## Mandatory Checks
Before implementing UI, inspect:
1. Existing design system, tokens, or component library rules.
2. If no project standard exists, use `ui-design-system.md` in this shared directory.
3. Similar page layouts.
4. Existing business and base components.
5. Common Tailwind usage.
6. Common spacing, type, radius, colors, and button styles.
7. Existing table, form, modal, and card patterns.
8. Common viewport behavior and first-screen fit.

## Component Priority
Implementation priority:
1. Existing business components.
2. Existing base components.
3. Component library components.
4. Native HTML tags.

Do not fall back to raw HTML assembly when an appropriate component already exists.

## Tailwind Rules
- Prefer existing Tailwind patterns in the project.
- Prefer semantic and consistent classes.
- Prefer Tailwind token values that map to design tokens.
- Avoid arbitrary values unless necessary.

## Preferred Mapping
- `text-xs` over `text-[12px]`
- `rounded-md` over `rounded-[6px]`
- `px-3 py-2` over fragmented arbitrary values
- `gap-2 / gap-3 / gap-4` over `gap-[10px]`

## UI Optimization Means
When the user asks to optimize UI, include:
1. Align with existing page style.
2. Improve hierarchy and spacing consistency.
3. Improve readability.
4. Improve interaction states.
5. Reduce meaningless classes and nested structure.
6. Reuse components instead of rewriting.
7. Check type, spacing, component sizes, and first-screen viewport behavior against the shared UI design system.

## Forbidden
- Redesigning style without inspecting existing pages.
- Arbitrary values that break consistency.
- Oversized type, padding, or random colors without evidence.
- Meaningless scroll on login, register, or simple settings pages due to decoration or unbalanced proportions.
- Putting all styles on a single JSX node.
- Handwriting many native control appearances when a component library exists.

