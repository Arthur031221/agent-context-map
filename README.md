<h1 align="center"><img src="assets/logo.svg" width="56" alt=""><br>agent-context-map</h1>
<p align="center"><strong>See which repository instructions may apply to a target path.</strong></p>
<p align="center"><img src="assets/demo.gif" alt="A repository tree labels instructions as predicted, conditional, or skipped." width="100%"></p>

<p align="center">
  <a href="https://github.com/Arthur031221/agent-context-map/stargazers"><img src="https://img.shields.io/github/stars/Arthur031221/agent-context-map?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/Arthur031221/agent-context-map/actions/workflows/ci.yml"><img src="https://github.com/Arthur031221/agent-context-map/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Arthur031221/agent-context-map" alt="MIT license"></a>
</p>

<p align="center"><a href="#quickstart">Quickstart</a> | <a href="#example">Example</a> | <a href="#how-it-works">How it works</a> | <a href="#limits">Limits</a></p>

> [!TIP]
> Install from GitHub with one command:
> ```sh
> npm install --global github:Arthur031221/agent-context-map
> ```

## Why agent-context-map

A repository can have root instructions, nested instructions, client specific files, and path scoped rules. When an agent works on one directory, the important question is which of those files may reach that task, and which ones stay out of scope.

`agent-context-map` scans repository files and explains its prediction for a selected target. It separates instructions found at the launch directory from nested files that may matter when work reaches them. The JSON report pairs each client's decisions with its ruleset source, assumptions, and ruleset identifier.

## Features

* **Path aware decisions:** inspect one file or directory from a chosen launch directory.
* **Three documented rulesets:** compare instruction file behavior across supported coding clients.
* **Decision reasons:** see predicted, conditional, skipped, and unknown files in a readable tree.
* **Machine readable output:** use `--json` for ruleset identifiers, source links, assumptions, and decisions.
* **Conservative scanning:** symlinked, oversized, unreadable, or unsupported files stay unknown.
* **Local only:** repository contents are read from disk and never sent to a service.

## Quickstart

Requires Node.js 22 or newer.

```sh
npm install --global github:Arthur031221/agent-context-map
agent-context-map packages/api/src/route.ts --agent codex
```

Run the command from the directory where your coding client starts. The target path is relative to that launch directory. Use `--root` when you want to choose the repository root explicitly.

## Example

Run the example from the cloned repository root. This five line invocation scans the included sample workspace:

```sh
agent-context-map \
  packages/api/src/route.ts \
  --launch-dir examples/demo-workspace \
  --root examples/demo-workspace \
  --agent codex
```

The output separates the root instruction from the nested API file and the unrelated web sibling:

```text
  |-- AGENTS.md [PREDICTED] Selected by filename priority on the path from the repository root to the launch directory.
  \-- packages/
      |-- api/
      |   \-- AGENTS.md [CONDITIONAL] This file is outside the startup chain. It may apply if explicitly read or if a new session starts in this directory.
      \-- web/
          \-- AGENTS.md [SKIPPED] This file is outside the launch and target paths.
```

## How it works

The scanner walks repository files, resolves the launch path and target path, then evaluates candidates under dated documentation rulesets. It reports the inputs it could inspect and keeps unsupported behavior visible as `unknown` or as a coverage warning.

A configuration linter can tell you that an instruction file has a known formatting or content problem. This map answers the path question: which repository files may apply to this target, and why?

## Limits

This is a static prediction, not a live session inspection. It does not read user, account, organization, or team settings. It also does not infer semantic relevance, follow symlinks, or resolve imported instruction files. The ruleset source and assumptions appear in `--json` output so you can judge where the prediction may differ from a specific installation.

Common generated folders are skipped, and scan depth, file count, and individual file size have limits. Unsupported glob syntax and unreadable candidate files are reported as unknown.

<details>
<summary><strong>Options</strong></summary>

| Option | Purpose |
| --- | --- |
| `--agent ID\|all` | Select one ruleset or compare all three. |
| `--launch-dir PATH` | Set the directory from which the client starts. |
| `--root PATH` | Set the repository root explicitly. |
| `--json` | Print structured output with rule sources and assumptions. |
| `--version` | Print the package version. |

</details>

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. Keep behavior tied to published documentation and include a focused fixture for a rule change.

## License

MIT. See [LICENSE](LICENSE).
