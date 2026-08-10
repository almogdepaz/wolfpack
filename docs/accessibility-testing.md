# Mobile screen-reader validation

Automated axe scans cover the active sessions view, settings, and modal dialogs. Before a release, also run these manual checks on a packaged build because browser automation cannot validate screen-reader speech or touch exploration.

## VoiceOver (iOS)

- Navigate the session switcher by button and list-item semantics; confirm current/expanded state is announced.
- Open and dismiss settings and confirmation dialogs; confirm focus enters the surface and returns to its trigger.
- Increase Dynamic Type/browser zoom and confirm session cards, controls, and terminal transcript remain operable.
- Open the software keyboard and confirm terminal controls remain visible above the visual viewport.

## TalkBack (Android)

- Repeat session drawer navigation and verify current/pressed states are announced.
- Explore settings by touch and confirm every toggle and icon button has an accessible name and at least a 44 px target.
- Confirm reduced-motion mode avoids non-essential view and loading animation.
- Confirm cached terminal output privacy text, opt-out, and clear status are announced.
