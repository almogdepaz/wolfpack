# libghostty-vt cutover evidence

status: accepted
revision: `50381104336ae07bf354e7ee1d579fb871bb5352`
profile: `full`
host: `aarch64-macos`

raw artifacts:
- `.plans/libghostty-vt-evidence-legacy.json`
- `.plans/libghostty-vt-evidence-ghostty.json`
- `.plans/libghostty-vt-evidence-evaluation.json`

## correctness

| scenario | expectation | legacy expected state | Ghostty expected state | snapshot hash | verdict |
| --- | --- | ---: | ---: | --- | --- |
| plain-shell | parity | true | true | equal | parity |
| ansi-color | parity | true | true | equal | parity |
| alternate-screen-editing | parity | true | true | equal | parity |
| scroll-region | parity | true | true | equal | parity |
| wide-combining-text | parity | true | true | equal | parity |
| dec-special-graphics | expected-state | false | true | different | ghostty win |
| cursor-bar | expected-state | false | true | different | ghostty win |
| custom-tab-stop | expected-state | false | true | different | ghostty win |

## safety

- deterministic seed: `0x6d5a56da5eed`
- legacy: 10000 iterations, 0 failures
- Ghostty: 10000 iterations, 0 failures

## performance

| metric | legacy | Ghostty | ratio | threshold |
| --- | ---: | ---: | ---: | ---: |
| feed median (MiB/s) | 10.900 | 120.748 | 11.078x | >= 2.000x |
| snapshot p95 (ms) | 9.748 | 11.038 | 1.132x | <= 1.200x |
| attach/reflow p95 (ms) | 14.542 | 15.428 | 1.061x | <= 1.100x |
| ~500-line RSS/session (bytes) | 5039718 | 684851 | 0.136x | <= 0.500x |
| ~5,000-line RSS/session (bytes) | 47392358 | 1137049 | 0.024x | <= 0.500x |

Exact sample distributions are preserved in the raw JSON artifacts.

## acceptance failures

- none

## toolchain

- cargo: `cargo 1.89.0 (c24e10642 2025-06-23)`
- rustc: `rustc 1.89.0 (29483883e 2025-08-04)`
- bun: `1.3.9`

## commands

- `cargo run --release --locked --manifest-path broker/Cargo.toml --example terminal-evidence -- --profile full`
- `cargo run --release --locked --manifest-path broker/Cargo.toml --features ghostty-vt --example terminal-evidence -- --profile full`
