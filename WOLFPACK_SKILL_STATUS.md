# wolfpack skill status

## goal
- add a wolfpack skill that teaches agents how to discover and control wolfpack terminal sessions across a tailnet.
- document the exposed skills in README.
- commit, push, and open a PR.

## status
- [x] branch created from latest main: `wolfpack-skill`
- [x] add tailnet control skill
- [x] document skills in README
- [x] verify docs/formatting (`git diff` reviewed; `bun test` run but fails on unrelated env/test-helper issues)
- [x] commit created (`add wolfpack tailnet control skill`)
- [x] push branch (`origin/wolfpack-skill`)
- [ ] open PR (blocked: GitHub API token returned 401 Bad credentials)

## verification notes
- `bun test` result: 1486 pass, 19 fail.
- failures are unrelated to docs/skill changes:
  - broker integration tests cannot spawn `/bin/zsh` in this linux container.
  - ralph active-PID tests rely on `exec -a "ralph-macchio worker" sleep`, blocked by the local coreutils security wrapper.
