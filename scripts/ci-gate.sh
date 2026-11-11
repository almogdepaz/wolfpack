#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

stages=(context rustfmt lint broker-build clippy broker-test audit assets typecheck unit integration bundle e2e-pr perf)
selected=()
with_audit=false
list=false
for argument in "$@"; do
  case "$argument" in
    --list) list=true ;;
    --with-audit) with_audit=true ;;
    *)
      if [[ " ${stages[*]} " != *" $argument "* ]]; then
        printf 'ci-gate: unknown stage: %s\n' "$argument" >&2
        exit 2
      fi
      selected+=("$argument")
      ;;
  esac
done

require_broker() {
  local broker="${WOLFPACK_BROKER_BIN:-broker/target/release/wolfpack-broker}"
  if [[ ! -f "$broker" || ! -x "$broker" ]]; then
    echo 'ci-gate: broker binary missing; run scripts/ci-gate.sh broker-build' >&2
    exit 1
  fi
  export WOLFPACK_BROKER_BIN="$(cd "$(dirname "$broker")" && pwd)/$(basename "$broker")"
}

stage_context() { bun run check:context; }
stage_rustfmt() { cargo fmt --manifest-path broker/Cargo.toml --check; }
stage_lint() { bun run lint; }
# Like broker-build, Clippy requires the verified native bundle prepared at setup.
stage_clippy() {
  # Plan 005 triage found only style/API-shape reports for these rules.
  # Keep all other default Clippy diagnostics; do not allow warnings globally.
  cargo clippy --locked --manifest-path broker/Cargo.toml --all-targets -- \
    -A clippy::unnecessary_map_or -A clippy::derivable_impls \
    -A clippy::len_without_is_empty -A clippy::too_many_arguments \
    -A clippy::single_match -A clippy::vec_init_then_push \
    -A clippy::manual_pattern_char_comparison -A clippy::bool_assert_comparison \
    -A clippy::io_other_error -A clippy::type_complexity
}
stage_broker_build() { cargo build --release --locked --manifest-path broker/Cargo.toml --bin wolfpack-broker; }
stage_broker_test() { cargo test --locked --manifest-path broker/Cargo.toml --all; }
stage_audit() {
  if [[ "${CI:-}" != true && "$with_audit" != true ]]; then
    echo 'ci-gate: audit skipped (requires CI=true or --with-audit; uses the network)'
    return
  fi
  npm i --package-lock-only --ignore-scripts 2>/dev/null
  npm audit --audit-level=high
  rm -f package-lock.json
}
stage_assets() {
  bun run scripts/gen-assets.ts
  git diff --exit-code src/public-assets.ts
}
stage_typecheck() { bun run typecheck; }
stage_unit() { bun test tests/unit/ tests/snapshot/; }
stage_integration() {
  require_broker
  local files=()
  mapfile -d '' files < <(find tests/integration -name '*.test.ts' ! -name 'auth-middleware.test.ts' -print0 | sort -z)
  test "${#files[@]}" -gt 0
  bun test "${files[@]}"
  bun test tests/integration/auth-middleware.test.ts
}
stage_bundle() { bun run check:bundle-budgets; }
stage_e2e_pr() {
  require_broker
  local project_names project paths files=()
  local report_dir="${PLAYWRIGHT_JSON_OUTPUT_DIR:-artifacts/e2e-pr}"
  mkdir -p "$report_dir"
  report_dir=$(cd "$report_dir" && pwd)
  project_names=$(bun -e 'import config from "./playwright.config"; for (const project of config.projects ?? []) console.log(project.name);')
  while IFS= read -r project; do
    paths=$(bun run scripts/e2e-tiers.ts pr --project "$project")
    [[ -n "$paths" ]] || continue
    mapfile -t files <<< "$paths"
    PLAYWRIGHT_JSON_OUTPUT_NAME="$report_dir/$project.json" \
      bunx --no-install playwright test "${files[@]}" --project="$project" --reporter=json,list
  done <<< "$project_names"
}
stage_perf() {
  # CI retains its separate device steps and their existing environment blocks.
  if [[ -n "${WOLFPACK_PERF_DEVICE:-}" ]]; then
    bun run perf:terminal-load
  else
    WOLFPACK_PERF_RUNS=3 WOLFPACK_PERF_DEVICE=desktop WOLFPACK_PERF_ENFORCE_BUDGETS=1 bun run perf:terminal-load
    WOLFPACK_PERF_RUNS=3 WOLFPACK_PERF_DEVICE=mobile WOLFPACK_PERF_ENFORCE_BUDGETS=1 bun run perf:terminal-load
  fi
}

if [[ "$list" == true ]]; then
  for stage in "${stages[@]}"; do
    printf '\n%s\n' "$stage"
    declare -f "stage_${stage//-/_}"
  done
  exit 0
fi
if [[ ${#selected[@]} == 0 ]]; then selected=("${stages[@]}"); fi
for stage in "${selected[@]}"; do
  printf '\nci-gate: %s starting\n' "$stage"
  start=$SECONDS
  # Do not invoke the stage in an if/|| condition: Bash would disable errexit
  # inside the entire function and could hide an earlier failed command.
  set +e
  (set -e; "stage_${stage//-/_}")
  code=$?
  set -e
  printf 'ci-gate: %s exit=%s duration=%ss\n' "$stage" "$code" "$((SECONDS - start))"
  if [[ "$code" != 0 ]]; then exit "$code"; fi
done
