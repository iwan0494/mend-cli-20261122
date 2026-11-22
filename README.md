[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/iwan0494/mend-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/iwan0494/mend-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` is one command-line tool that applies the edits AI models write,
in four formats, to a tree of text files — unified diffs (often with
wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor
tool calls as JSON — following the written specification in `SPEC.md`.

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root
  of the tree). When it is absent or `-`, the patch is read from stdin.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`, or `auto` (the default, which detects the format).
- `--check` does everything but write: same output and exit code, no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

An edit's old lines are found at the first of three matching tiers:
exact, trailing whitespace ignored, then leading and trailing
whitespace ignored. Every file is changed or none is: a failed edit
changes nothing, later edits still run and are all reported, and when
any edit failed no file is written at all.

Exit codes: 0 with one line per changed file (`A`, `D`, `M`, or `R`
for a move) plus `ok: <n> files`; 1 with one `error: <code> <path>`
line per failed edit plus `failed: <k> of <n> edits`; 2 with exactly
one line for a usage, no-patch, format or parse error.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone.
- `runner.ts` — the kit's runner, unchanged. In a trial it reads the
  checks from the environment and runs `main.ts` on each one.

## License

MIT — see `LICENSE`.
