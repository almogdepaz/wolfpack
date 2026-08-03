# explicit subagent disclosure

## goal

make the parent-session expansion control self-explanatory without increasing card height or weakening accessibility.

## success criteria

- collapsed control visibly says `show N agent(s)` with a right-facing chevron;
- expanded control visibly says `hide N agent(s)` with a downward chevron;
- accessible labels continue to use explicit expand/collapse child-agent wording;
- parent and ordinary session cards remain equal height when equivalent content is shown;
- drawer children remain bounded and adjacent to their parent;
- Chromium and mobile WebKit hierarchy coverage passes.

## non-goals

- changing hierarchy, ordering, or persistence semantics;
- adding another disclosure row;
- changing desktop/mobile layout structure;
- changing delegation identity.

## 1. strengthen disclosure regressions

assert visible action wording in both states while retaining card-height and chevron-state checks.

## 2. render explicit action labels

replace count-only shorthand with compact show/hide agent labels and retain the rotating chevron.

## 3. verify and deploy

run hierarchy, navigation, accessibility, and full regressions, then deploy with broker replacement disabled.
