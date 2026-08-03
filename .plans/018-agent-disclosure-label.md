# agent disclosure label

## goal

use clearer compact delegation labels and add breathing room between the chevron and text.

## success criteria

- visible labels read `1 agent` / `N agents`;
- chevron-to-text gap is at least 4px;
- existing chevron state, accessibility labels, card height, hierarchy, and bounds remain unchanged;
- focused Chromium and mobile WebKit coverage passes;
- deploy locally with broker replacement disabled.

## tasks

1. update regression expectations for label and spacing.
2. update label pluralization and control gap.
3. verify and deploy.
