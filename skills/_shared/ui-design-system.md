# UI Design System Rules

## Goal
Provide a stable visual baseline for new or refined UI. Prevent uncontrolled type, spacing, first-screen overflow, random colors, and inconsistent component sizes.

If the target project has a stronger design system, component library, or tokens, follow the project standard first.

## Design Principles
- Consistency: keep color, type, spacing, radius, shadow, and interaction states unified.
- Hierarchy: establish information priority through type, weight, color, spacing, and section weight.
- Readability: readability beats decoration.
- Accessibility: target WCAG AA; body text contrast should be at least 4.5:1.
- Responsive: desktop, tablet, and mobile must all be usable.
- Viewport fit: single-task pages should avoid meaningless first-screen scroll.

## Design Tokens

### Color
Use semantic tokens by default. Do not scatter random colors.

Suggested baseline:
- `background`
- `surface`
- `surface-muted`
- `border`
- `border-strong`
- `text-primary`
- `text-secondary`
- `text-muted`
- `brand`
- `brand-hover`
- `success`
- `warning`
- `danger`
- `info`

### Typography
Default font stack:

```css
system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif
```

Type scale:
- Display: 48px / 56px
- H1: 36px / 44px
- H2: 30px / 38px
- H3: 24px / 32px
- H4: 20px / 28px
- Body: 16px / 24px
- Small: 14px / 20px
- Caption: 12px / 16px

Rules:
- Brand, hero, and auth page titles must not exceed H1 without reason.
- Single-task pages usually use H1/H2, not oversized display type.
- Minimum font size is 12px.
- Line height must match type size and remain readable.

### Spacing
Use an 8pt grid. Preferred values:
- 4px
- 8px
- 12px
- 16px
- 24px
- 32px
- 40px
- 48px
- 64px

Rules:
- Form internal spacing: usually 8-16px.
- Component spacing: usually 16-24px.
- Section spacing: usually 32-48px.
- Single-task first screens should not use 64px+ spacing without reason.
- Do not add excessive padding just to look premium when it causes meaningless scroll at common desktop heights.

### Radius
- Small controls: 6-8px.
- Cards and panels: 12-16px unless project standard differs.
- Avoid mixing many radius values in one surface.

### Shadow
- Cards default to at most `shadow-md`.
- Do not add shadows to every section.
- Shadow represents elevation, not decoration.

## Layout System

### Grid And Width
- Default to 12-column grid.
- Base unit: 8px.
- Max content width: 1440px.
- Use reasonable max-width to avoid over-stretched large screens.

### Breakpoints
- Mobile: 375px+
- Tablet: 768px+
- Desktop: 1024px+
- Wide: 1440px+

### Viewport Baseline
Desktop web should check:
- 1024x768
- 1280x800
- 1440x900

Single-task pages such as login, register, password reset, and simple settings:
- should avoid meaningless vertical scroll at the common desktop sizes above
- must scroll only because of real content, not oversized type, padding, decoration, or equal-weight split columns
- should make one side primary and the other supportive

## Component Standards

### Button
- Default height: 40px.
- Small: 32px.
- Large: 48px.
- Minimum target area: 44x44px.
- Cover hover / focus / pressed / disabled / loading.
- Default transition: 150-200ms.

### Input
- Default height: 40px.
- Default radius: 8px.
- Cover focus / error / disabled / placeholder.
- Keep label, helper text, and error text hierarchy stable.

### Card
- Default padding: 24px.
- Default radius: 16px.
- Default max shadow: `shadow-md`.
- Do not give every card identical height, border, and shadow without reason.

## Motion
- Default transition: 150-200ms.
- Use motion for state change, feedback, and hierarchy transition.
- Avoid decorative animation on dashboards and data-dense pages.

## Accessibility
- Body text contrast >= 4.5:1.
- Large text contrast >= 3:1.
- Minimum touch area 44x44px.
- Minimum font size 12px.
- Keyboard access and visible focus state are required.

## Engineering Rules
Forbidden:
- magic numbers
- random colors
- random shadows
- random radius
- random oversized type
- arbitrary viewport height assumptions

Required:
- use design tokens or existing project tokens
- use unified spacing
- use unified typography
- use unified component APIs or existing component patterns
- check common viewport fit

## Quality Checklist
- Is type inside the type scale?
- Are brand/hero sizes controlled?
- Does the page use 8pt spacing?
- Does a single-task page avoid meaningless scroll at 1024x768 / 1280x800 / 1440x900?
- Are card, button, and input sizes consistent?
- Are hover / focus / disabled / loading / error states covered?
- Do colors, radius, and shadow come from tokens or project patterns?
- Are contrast, touch target, and minimum type size acceptable?

