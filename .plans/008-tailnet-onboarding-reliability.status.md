# status — tailnet onboarding reliability

- immutable plan: `.plans/008-tailnet-onboarding-reliability.md`
- sha256: `3369fb921f6d267e6d8a617c75cf3a2d8b1c0e8ecdbe12b2119169d57888efe5`
- worktree: `/Users/home/Dev/wolfpack-tailnet-onboarding-reliability`
- branch: `fix/tailnet-onboarding-reliability`
- overall state: `review_required`
- current phase: code/test review complete; real signed-in Tailnet phone verification remains

## task states

| task | state | direct contribution / scope check |
| --- | --- | --- |
| 1. lock the remote-setup contract with focused failing tests | `implemented` | red observed for missing helper; focused tests green after implementation |
| 2. extract and harden Tailscale configuration | `implemented` | fixed-argument subprocess boundary only; no browser execution |
| 3. make the interactive wizard resumable and truthful | `implemented` | preserves Tailnet/loopback trust boundaries and broker sessions |
| 4. align public guidance with the real product path | `implemented` | README presents Tailnet phone access as primary and localhost as desktop-only |
| 5. verify behavior and review the trust boundary | `review_required` | typecheck/full test suite pass; `.plans/008-tailnet-onboarding-reliability.security-review.md` is conditional pending real Tailnet-phone evidence |

## decisions

- `tailscale serve status --json` is the local structured verification source; it does not replace a real Tailnet-phone check.
- no config mutation or remote QR is allowed on unverified setup failure.
- no local-only setup mode is introduced.

## next action

Perform a signed-in Tailnet phone scan against the PR build. Confirm the HTTPS QR opens the existing Wolfpack session, then mark task 5 accepted.
