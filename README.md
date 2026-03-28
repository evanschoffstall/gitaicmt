<a name="top"></a>

<div align="center">

<br/>

<h1>gitaicmt</h1>

<img src="logo.svg" width="112" height="112" alt="gitaicmt logo" />

<p><em>Run it. Done.</em></p>

<p>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 5" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-runtime-F9F1E1?style=for-the-badge&logo=bun&logoColor=black" alt="Bun" /></a>
  <a href="https://platform.openai.com/docs/overview"><img src="https://img.shields.io/badge/OpenAI-API-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI API" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge" alt="MIT License" /></a>
</p>

<p>
  High quality AI-powered git commit messages that actually make sense.<br/>
  Reads your staged diff, splits logical changes across files and hunks, previews the plan, then writes Conventional Commits automatically.<br/>
  If nothing is staged, it stages tracked changes for you first.
</p>

<p>
  <a href="#quick-start"><strong>Quick Start</strong></a> ·
  <a href="#commands"><strong>Commands</strong></a> ·
  <a href="#configuration"><strong>Configuration</strong></a> ·
  <a href="#development"><strong>Development</strong></a>
</p>

<br/>

</div>

> [!IMPORTANT]
> `gitaicmt` can stage and commit changes. If you want a no-side-effects preview first, run `gitaicmt plan`.

---

## What is gitaicmt?

**gitaicmt** is a Bun-based CLI that inspects your git diff, asks an OpenAI text model to group related changes, and generates commit messages that are actually useful.

It is built for the real workflow problem, not just the message-writing problem:

- large staged batches
- unrelated hunks in the same file
- preview-before-commit safety
- automatic commit execution after confirmation

If you want to inspect the plan before anything is committed, run `gitaicmt plan`.

> [!TIP]
> The tool is strongest when you already have a meaningful staged diff. If you prefer tighter control, stage intentionally first and use `gitaicmt plan` before `gitaicmt`.

---

## Why use it?

|     | Feature | Description |
| --- | --- | --- |
| 🧠 | **AI-generated messages** | Produces commit subjects and bodies from the actual diff |
| 🔀 | **Auto-split commits** | Separates unrelated work into multiple logical commits |
| 🧪 | **Hunk-level splitting** | Can split changes inside the same file when the hunks represent different intents |
| 📋 | **Plan-first workflow** | Shows the planned commits before it starts committing |
| 🚀 | **Automatic staging fallback** | If nothing is staged, it stages tracked changes automatically |
| 📝 | **Conventional Commits** | Uses `type(scope): description` by default |
| ⚡ | **Parallel analysis** | Chunks large diffs and processes them concurrently |
| 🔧 | **Configurable output** | Control model, temperature, token warnings, language, body inclusion, and more |
| 🏗️ | **Pipe-friendly mode** | `gitaicmt gen` prints a single message to stdout for scripting |

### At a glance

| Category | Default behavior |
| --- | --- |
| Diff source | Uses staged changes when present |
| Empty staging area | Auto-stages tracked changes |
| Normal run | Shows the plan, asks once, then commits |
| Preview run | `gitaicmt plan` shows the split and exits |
| Pipe run | `gitaicmt gen` prints one message to stdout |
| Default model | `gpt-4o-mini` |

---

## Safety and Behavior

Before using it on a real repository, the important behavior is this:

1. `gitaicmt` reads the diff that will be committed.
2. If you already have staged changes, it uses those.
3. If nothing is staged, it stages tracked changes automatically.
4. In default mode, it shows the plan and asks once before committing.
5. `gitaicmt plan` previews the split without committing.
6. `gitaicmt gen` generates a single message and prints it to stdout.

> [!NOTE]
> The README calls out side effects early because this tool writes to git state, not just stdout.

### What gets sent to the model?

The tool sends diff content and commit-format instructions so the model can:

- group related changes
- generate commit subjects and optional bodies
- follow your configured language and formatting rules

### What does not exist today?

The current configuration supports OpenAI API credentials and model selection. It does **not** expose a custom provider or base URL setting in the documented config surface.

> [!WARNING]
> If you need provider switching or custom API endpoints, that is not a documented feature of the current release.

---

## Quick Start

### 1. Install from source

```bash
bun install
bun run build
bun link
```

### 2. Set your API key

```bash
export OPENAI_API_KEY="sk-..."
```

Or create a project config file:

```bash
gitaicmt init
```

### 3. Preview the plan

```bash
gitaicmt plan
```

### 4. Commit

```bash
gitaicmt
```

> [!TIP]
> If the staged diff is large, keep token warnings enabled the first time you use the tool.

---

## Example

Input:

```text
Staged changes:
- refactor commit planner batching
- fix terminal line wrapping regression
- add planner notice tests
```

Possible plan:

```text
1. ref(commit-planning): tighten batching for grouped diff analysis
2. fix(cli): preserve wrapped terminal output alignment
3. test(cli): cover planner fallback notices
```

Pipe mode:

```bash
gitaicmt gen | git commit -F -
```

<details>
  <summary><strong>What this example is demonstrating</strong></summary>
  <p>The planner is trying to separate different intents into separate commits instead of collapsing everything into a single generic message. That is the core value of the tool.</p>
</details>

---

## Commands

| Command | Alias | Description |
| --- | --- | --- |
| `gitaicmt` | `c` | Detect changes, show the plan, confirm once, then commit |
| `gitaicmt plan` | `p` | Preview planned commit groups without committing |
| `gitaicmt single` | `s` | Generate one commit for all changes |
| `gitaicmt gen` | `g` | Generate one message to stdout |
| `gitaicmt init` |  | Create `gitaicmt.config.json` in the current directory |
| `gitaicmt version` |  | Show version information |
| `gitaicmt help` | `-h` | Show help |

## Flags

| Flag | Description |
| --- | --- |
| `-y`, `--yes` | Skip confirmation prompts |
| `--no-token-check` | Skip the high-token confirmation prompt for one run |
| `-v`, `--verbose` | Show concise diagnostics and stage summaries |
| `--trace` | Show raw intermediate AI payloads |
| `--version` | Show version information |
| `-h`, `--help` | Show help |

> [!NOTE]
> `gitaicmt`, `gitaicmt single`, and `gitaicmt gen` solve different problems: split-and-commit, one-commit-for-all, and message-only output.

---

## Common Usage

```bash
# Preview the split before any commit runs
gitaicmt plan

# Auto-split into logical commits and ask once
gitaicmt

# Same as above, but skip confirmation
gitaicmt -y

# Show extra planning diagnostics
gitaicmt -v plan

# Show raw intermediate AI payloads during planning
gitaicmt --trace plan

# Generate one message for all changes
gitaicmt single

# Pipe a generated message into git
gitaicmt gen | git commit -F -
```

<details>
  <summary><strong>Choosing the right mode</strong></summary>

| Use case | Command |
| --- | --- |
| Preview logical commit grouping | `gitaicmt plan` |
| Let the tool split and commit | `gitaicmt` |
| Force a single commit | `gitaicmt single` |
| Generate a message for your own scripting flow | `gitaicmt gen` |

</details>

---

## Configuration

Configuration is loaded and deep-merged in this order, with later entries winning:

1. `/etc/gitaicmt/config.json`
2. `~/.config/gitaicmt/config.json` or `$XDG_CONFIG_HOME/gitaicmt/config.json`
3. `./gitaicmt.config.json` or `./.gitaicmt.json`
4. `OPENAI_API_KEY` environment variable

Create a local config file:

```bash
gitaicmt init
```

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
    "model": "gpt-4o-mini",
    "temperature": 0.3
  },
  "performance": {
    "cacheEnabled": true,
    "cacheTTLSeconds": 300,
    "parallel": true,
    "timeoutMs": 15000
  }
}
```

</details>

### Token warning behavior

Token usage is estimated before model calls. When the estimate reaches `analysis.tokenWarningThreshold`, gitaicmt warns and asks for confirmation by default.

- Set `analysis.promptOnTokenWarning` to `false` to disable the prompt.
- Set `analysis.tokenWarningThreshold` to `0` to disable token warnings entirely.
- Pass `--no-token-check` to bypass the prompt for one run.

> [!CAUTION]
> Disabling token warnings removes the last confirmation step for unusually large model requests.

---

## Recommended Models

The default model is `gpt-4o-mini`.

The codebase currently documents these as sensible text-generation choices for commit generation:

- `gpt-4o-mini`
- `gpt-4o`
- `gpt-4.1-mini`
- `gpt-4.1`
- `gpt-5-mini`
- `gpt-5`
- `gpt-5.3-chat-latest`
- `gpt-5.3-codex`
- `o3`
- `o4-mini`

<details>
  <summary><strong>How to think about model choice</strong></summary>
  <p><code>gpt-4o-mini</code> is the default because it is a pragmatic latency and cost baseline. Move up only when your diffs are large or your project structure is complex enough to justify the extra reasoning budget.</p>
</details>

---

## Development

This repository uses Bun end to end.

### Local development

```bash
bun install
bun run build
```

> [!NOTE]
> This repository's canonical validation entrypoint is `bun check summary`.

### Validation

```bash
bun check summary
```

### Build

```bash
bun run build
```

---

## Project Structure

```text
gitaicmt/
├── src/
│   ├── application/               # Config, constants, schemas, and runtime errors
│   ├── cli/                       # CLI entry point, staging, plan display, and terminal UI
│   ├── commit-messages/           # Commit message formatting and subject parsing helpers
│   ├── commit-planning/           # AI orchestration, prompts, grouping, caching, and planning logic
│   └── git/                       # Git diff parsing and command execution
├── tests/
├── scripts/
├── package.json
└── tsconfig.json
```

---

## Stack

| Layer | Technology |
| --- | --- |
| Runtime | Bun |
| Language | TypeScript 5 |
| AI | OpenAI API |
| Validation | `bun check summary` |

---

## FAQ

<details>
  <summary><strong>Will this commit immediately?</strong></summary>
  <p>In the default mode, it shows the plan and asks once before committing. If you only want the preview, use <code>gitaicmt plan</code>.</p>
</details>

<details>
  <summary><strong>Does it require staged changes?</strong></summary>
  <p>No. If nothing is staged, it stages tracked changes automatically before continuing.</p>
</details>

<details>
  <summary><strong>Can I use it in scripts?</strong></summary>
  <p>Yes. Use <code>gitaicmt gen</code> to print a single generated message to stdout.</p>
</details>

---

<div align="center">

Made with ❤️ by [Evan Schoffstall](https://github.com/evanschoffstall)

<br/>

<a href="#top">Back to top</a>

</div>
