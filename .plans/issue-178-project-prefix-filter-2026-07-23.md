# issue #178: project prefix filtering

status: filtering, autofocus, and relabeling verified and deployed server-only

success criteria:
- typing filters the already-fetched project list by case-insensitive name prefix
- filtering makes no additional project request
- empty or whitespace-only input restores all projects
- clicking a filtered result preserves existing-project selection
- Enter preserves typed-project creation
- desktop and mobile browser behavior is covered
- opening the picker focuses the project-name input immediately
- the input placeholder reflects both filtering and creation

## ~~1. Add regression coverage~~
- add pure behavior tests for prefix, case, substring rejection, and reset
- add browser coverage for filtering, request count, reset, and existing-project selection
- observe the focused tests fail before production changes

## ~~2. Implement local project filtering~~
- extract the smallest pure filter helper
- retain the fetched project names in browser state
- rerender the list on input without changing selection/create flows

## ~~3. Verify and deploy~~

verification:
- focused unit: 3 passed
- focused browser: 3 passed across iPhone SE, iPhone 14, and desktop
- full Bun: 1,818 passed, 21 optional broker skips before binary build
- real-broker integration: 13 passed
- full Playwright with broker: 108 passed, 126 expected project skips
- typecheck and diff checks passed
- deployed server-only: server 36536 -> 11803; broker remained 36530; 6 session identities preserved
- live browser: 40 projects restored after clearing; uppercase `CL` filtered to 3 valid prefix matches

## ~~4. Autofocus and relabel follow-up~~

follow-up verification:
- focused browser red: 3 failed because the input was inactive
- focused browser green: 3 passed across iPhone SE, iPhone 14, and desktop
- full Bun with broker: 1,831 passed
- full Playwright: 108 passed, 126 expected project skips
- typecheck and diff checks passed
- deployed server-only: server 11803 -> 86432; broker remained 36530; 4 session identities preserved
- live click path confirmed active element `new-project-name` with placeholder `Project name`
- add a failing cross-viewport browser regression for focus and placeholder
- focus without scrolling as soon as the picker opens
- regenerate assets, verify, and redeploy server-only
