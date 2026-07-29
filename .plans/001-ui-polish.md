# wolfpack interaction and visual polish

## Goal
Make Wolfpack feel deliberate and fluid across desktop and mobile while preserving its dark mono terminal identity and all terminal/session semantics.

## Success criteria
- desktop session browsing uses intentional content density rather than full-width billboard rows
- collapsed desktop navigation has a visible, keyboard/click-accessible affordance
- session, machine, navigation, and terminal controls expose clear accessible names and consistent visual hierarchy
- mobile session browsing, terminal navigation, accessory keys, and compose controls remain usable at 375px without horizontal overflow
- settings and creation pickers have clear section hierarchy and bounded readable width
- animations remain restrained and honor both the existing setting and `prefers-reduced-motion`
- existing session, grid, terminal, and delegation behavior remains unchanged

## Non-goals
- broker, websocket, terminal hydration, replay, resize, or session lifecycle changes
- changing the neon-green mono visual identity
- introducing a UI framework, icon package, or new runtime dependency
- redesigning information architecture or removing existing controls

## 1. Lock observable polish contracts
Add browser-level regressions for semantic control names, visible collapsed navigation, mobile viewport fit, touch-target sizing, and bounded desktop content.

## 2. Refine the responsive application shell
Replace platform-dependent mystery glyphs with consistent inline icons and labels, add a real collapsed-sidebar handle, improve desktop density, and clarify mobile header/navigation hierarchy.

## 3. Refine sessions, pickers, and settings
Improve card hierarchy, action discoverability, contrast, readable content width, section grouping, and interactive states without changing session behavior.

## 4. Refine terminal and grid chrome
Clarify terminal accessory/action hierarchy, reduce noisy button styling, tighten grid headers, and preserve maximum terminal canvas space on mobile and desktop.

## 5. Verify behavior and presentation
Run focused browser tests, typechecks, the full test suite, relevant e2e coverage, and fresh desktop/mobile browser screenshots. Record any environment-limited verification explicitly.
