<a name="top"></a>

<div align="center">

<br/>

<img src="logo.svg" width="112" height="112" alt="gitaicmt logo" />

<h1>gitaicmt</h1>

<p><em>Rigorous AI-powered conventional commits</em></p>

<p>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 5" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-runtime-F9F1E1?style=for-the-badge&logo=bun&logoColor=black" alt="Bun" /></a>
  <a href="https://platform.openai.com/docs/overview"><img src="https://img.shields.io/badge/OpenAI-API-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI API" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge" alt="MIT License" /></a>
</p>

<p>
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#commands"><strong>Commands</strong></a> ·
  <a href="#configuration"><strong>Configuration</strong></a> ·
  <a href="#development"><strong>Development</strong></a>
</p>

<br/>

</div>

**gitaicmt** reads your staged diff, groups related changes by intent, and generates `type(scope): description` commit messages — one per logical unit. Large batches, mixed hunks, unrelated files: it handles all of it and shows you the plan before touching anything.

> [!IMPORTANT]
> `gitaicmt` can stage and commit changes. Run `gitaicmt plan` for a no-side-effects preview.

---

## Quick Start

```bash
bun install && bun run build && bun link
export OPENAI_API_KEY="sk-..."
gitaicmt plan   # preview — no side effects
gitaicmt        # split and commit
```

Or scaffold a local config:

```bash
gitaicmt init
```

---

## Example

```text
Staged: refactor planner batching, fix terminal wrapping, add planner tests
```

```text
1. ref(commit-planning): tighten batching for grouped diff analysis
2. fix(cli): preserve wrapped terminal output alignment
3. test(cli): cover planner fallback notices
```

Pipe mode:

```bash
gitaicmt gen | git commit -F -
```

---

## Commands

| Command            | Alias | Description                          |
| ------------------ | ----- | ------------------------------------ |
| `gitaicmt`         | `c`   | Show plan, confirm once, then commit |
| `gitaicmt plan`    | `p`   | Preview commit groups — no commits   |
| `gitaicmt resume`  | `r`   | Replay a saved plan bundle by hash   |
| `gitaicmt single`  | `s`   | One commit for all changes           |
| `gitaicmt gen`     | `g`   | Print one message to stdout          |
| `gitaicmt init`    |       | Create `gitaicmt.config.json`        |
| `gitaicmt version` |       | Show version                         |
| `gitaicmt help`    | `-h`  | Show help                            |

## Flags

| Flag               | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `-b`, `--breaking` | Mark release-impacting conventional subjects as breaking |
| `-y`, `--yes`      | Skip confirmation prompts                                |
| `--no-token-check` | Skip the token warning for one run                       |
| `-v`, `--verbose`  | Show diagnostics and stage summaries                     |
| `--trace`          | Show raw AI payloads                                     |
| `--only <n[,m...]>` | Resume and execute only the listed commits              |
| `--from <n>`       | Resume and execute commits `n` through the end           |
| `--range <a>..<b>` | Resume and execute commits `a` through `b`               |
| `--version`        | Show version                                             |
| `-h`, `--help`     | Show help                                                |

---

## Common Usage

```bash
gitaicmt plan             # preview the split
gitaicmt                  # split and commit (asks once)
gitaicmt -y               # split and commit, no prompt
gitaicmt resume <hash>    # reuse a saved plan bundle later
gitaicmt resume <hash> --only 2,4,5   # run only selected planned commits
gitaicmt resume <hash> --from 3   # run commits 3 through the end
gitaicmt resume <hash> --range 2..4   # run only commits 2 through 4
gitaicmt -v plan          # verbose planning output
gitaicmt --trace plan     # raw AI payloads
gitaicmt single           # one commit for everything
gitaicmt gen | git commit -F -   # pipe mode
```

`plan` and the default commit flow save a hashed plan bundle under the user cache directory. The CLI prints the bundle hash after planning so you can replay the exact staged patch later with `gitaicmt resume <hash>` as long as the repository HEAD still matches.

---

## Configuration

Loaded and merged in this order — later entries win:

1. `/etc/gitaicmt/config.json`
2. `~/.config/gitaicmt/config.json` or `$XDG_CONFIG_HOME/gitaicmt/config.json`
3. `./gitaicmt.config.json` or `./.gitaicmt.json`
4. `OPENAI_API_KEY` environment variable

<details>
  <summary><strong>Default config</strong></summary>

```json
{
  "analysis": {
    "chunkSize": 800,
    "groupByFile": true,
    "groupByHunk": true,
    "maxDiffLines": 2000,
    "promptOnTokenWarning": true,
    "tokenWarningThreshold": 10000
  },
  "commit": {
    "conventional": true,
    "includeBody": true,
    "includeScope": true,
    "language": "en",
    "maxBodyLineLength": 80,
    "maxSubjectLength": 72
  },
  "openai": {
    "apiKey": "",
    "maxTokens": 512,
    "model": "gpt-5.3-codex",
    "temperature": 0.3
  },
  "performance": {
    "cacheEnabled": true,
    "maxSavedPlanBundles": 50,
    "parallel": true,
    "timeoutMs": 15000
  }
}
```

</details>

### Token warnings

Token usage is estimated before model calls. When the estimate exceeds `analysis.tokenWarningThreshold`, gitaicmt asks for confirmation.

- Set `analysis.promptOnTokenWarning: false` to disable the prompt.
- Set `analysis.tokenWarningThreshold: 0` to disable token warnings entirely.
- Pass `--no-token-check` to skip for one run.

> [!CAUTION]
> Disabling token warnings removes the last confirmation step before large model requests.

### Saved plan bundles

Saved plan bundles reuse `performance.cacheEnabled`, but they do not expire on a timer.

- Set `performance.cacheEnabled: false` to disable persisted plan bundles and in-memory planner caching together.
- `performance.maxSavedPlanBundles` controls how many saved bundle JSON files are kept. The default is `50`.
- Resume restores the original staged patch only when the current repository HEAD still matches the saved bundle.

---

## Recommended Models

Default: `gpt-5.3-codex` — a pragmatic latency and cost baseline. Move up when diffs are large or project structure is complex.

Other well-suited options: `gpt-4o`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-5`, `gpt-5-mini`, `gpt-5.3-chat-latest`, `o3`, `o4-mini`

> [!WARNING]
> Custom providers and base URL overrides are not a supported configuration surface in the current release.

---

## Development

```bash
bun install
bun run build
bun check summary   # canonical validation entrypoint
```

---

## Project Structure

```text
src/
├── application/      # Config, constants, schemas, and runtime errors
├── cli/              # Entry point, staging, plan display, and terminal UI
├── commit-messages/  # Message formatting and subject parsing
├── commit-planning/  # AI orchestration, prompts, grouping, caching, and planning
└── git/              # Diff parsing and command execution
```

---

## Stack

| Layer      | Technology          |
| ---------- | ------------------- |
| Runtime    | Bun                 |
| Language   | TypeScript 5        |
| AI         | OpenAI API          |
| Validation | `bun check summary` |

---

<div align="center">

Made with ❤️ by [Evan Schoffstall](https://github.com/evanschoffstall)

<br/>
