# taller agent disclosure

## goal

make the compact agent disclosure pill slightly easier to target without changing session-card height.

## success criteria

- mobile pill gains 1px vertical padding per side;
- compact desktop pill gains 1px vertical padding per side;
- parent and ordinary cards remain equal height;
- labels, chevron spacing, hierarchy, accessibility, and bounds remain unchanged;
- focused coverage and full tests pass;
- deploy locally with broker replacement disabled.

## tasks

1. add failing padding and card-height expectations.
2. increase vertical padding minimally.
3. verify and deploy.
