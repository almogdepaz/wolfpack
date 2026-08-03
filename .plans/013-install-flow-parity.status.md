# install flow parity status

- plan: `.plans/013-install-flow-parity.md`
- plan sha256: `55aaee948414f3955001bdbb740677af697de02bd6232b6483d896818a98638f`
- overall state: `accepted`
- current phase: complete

## task state

- task 1: `accepted`
- task 2: `accepted`
- task 3: `accepted`
- task 4: `accepted`

## evidence

- `install.sh` still hard-requires and auto-installs tmux; that block dates to the original tmux-backed implementation.
- current setup/runtime uses the broker and does not check tmux.
- cold-cache `bunx wolfpack-bridge --version` downloaded `wolfpack-bridge@1.6.10` plus the matching platform package and then exited 1 without CLI output.
- curl succeeds through a separate release-asset path that directly installs both binaries.
- root cause 1: the package exposed `wolfpack`, but `bunx wolfpack-bridge` looked for a same-name executable alias and exited 1.
- root cause 2: Bun blocks dependency postinstall; npm platform binaries remained mode 0644, the wrapper hit EACCES, and its catch path printed nothing.
- package manifest now exposes both names; runtime fallback marks server and broker executable and reports launch failures.
- staged 1.6.10 smoke package: Bun and npm both reported 1.6.10; Bun prepared both binaries as mode 0755.
- curl no longer checks or installs tmux.
- curl upgrades now restart only the server service instead of routing through full service installation.
- the generated backend-status schema now matches the broker-only runtime response and no longer requires a removed tmux count.
- full Bun suite: 1,475 passed, 0 failed.
- typecheck and `git diff --check` passed.
- final local `broker=no` deployment restarted server pid 79108 → 9993, preserved broker pid 73645 and all 8 sessions, and served the exact source bundle hash.
- live `/api/backend` response is broker-only: `{\"brokerAvailable\":true,\"counts\":{\"broker\":8}}`.

## next action

none.
