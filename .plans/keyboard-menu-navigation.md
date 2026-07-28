# desktop keyboard menu navigation

status: complete

## goal

Make the project picker and new-session agent picker keyboard-navigable on desktop without changing their pointer-only appearance until keyboard navigation begins.

## proposed behavior

1. Keep both pickers visually unchanged with no selected row initially.
2. On the first unmodified ArrowUp or ArrowDown, select the nearest list item (first for Down, last for Up) and add a dedicated visual-selection class.
3. Subsequent ArrowUp/ArrowDown moves the selection within the visible list, scrolling it into view.
4. Enter activates the selected project or agent; Escape retains the existing picker back/cancel behavior.
5. Pointer hover/click retains current behavior and does not imply a persistent keyboard selection.
6. Add focused browser coverage for project and agent navigation, initial no-highlight state, and activation.

## accepted interaction decisions

- ArrowUp/ArrowDown always enter menu navigation while either picker is visible, including when its text input has focus.
- ArrowLeft/ArrowRight retain normal text-input behavior.
