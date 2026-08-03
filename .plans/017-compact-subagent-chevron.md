# compact subagent chevron

## goal

make delegation expansion visibly clickable through a stronger compact chevron control, without long action text.

## success criteria

- visible text remains compact: `1 sub` / `N subs`;
- collapsed and expanded states use an obvious right/down chevron at least 7px square with a 2px stroke;
- the collapsed pill has sufficient border, background, and text contrast to read as interactive on touch devices;
- accessible labels remain explicit `Expand/Collapse N child agent(s)`;
- parent and ordinary cards retain equal height;
- child adjacency and drawer bounds remain unchanged;
- Chromium and mobile WebKit hierarchy coverage passes.

## non-goals

- long show/hide labels;
- changing hierarchy, ordering, or persistence;
- adding another row or icon asset;
- changing desktop/mobile structure.

## 1. strengthen affordance regression

assert compact wording, chevron dimensions/stroke, rotation, accessibility, and unchanged card height.

## 2. strengthen visual affordance

increase chevron size/stroke and collapsed pill contrast while preserving compact layout.

## 3. verify and deploy

run hierarchy, swipe-navigation, reorder, and full regressions, then deploy with broker replacement disabled.
