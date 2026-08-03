# larger agent disclosure

## goal

increase disclosure readability with more chevron separation and a 2px larger label while preserving card geometry.

## success criteria

- chevron-to-label gap is 8px on mobile and desktop;
- mobile label font increases from 9px to 11px;
- compact desktop label font increases from 8px to 10px;
- labels, pill padding, accessibility, hierarchy, and bounds remain unchanged;
- parent and ordinary cards retain equal outer heights;
- focused coverage and full tests pass;
- deploy locally with broker replacement disabled.

## tasks

1. raise gap and font-size regression expectations.
2. enlarge the control and rebalance internal desktop rows if required.
3. verify and deploy.
