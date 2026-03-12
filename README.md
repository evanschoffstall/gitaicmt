<div align="center">

<br/>

<h1>gitaicmt</h1>

<img src="logo.svg" width="112" height="112" alt="gitaicmt logo" />

<p><em>Run it. Done.</em></p>

<p>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript 5" /></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-runtime-F9F1E1?style=for-the-badge&logo=bun&logoColor=black" alt="Bun" /></a>
  <a href="https://openai.com"><img src="https://img.shields.io/badge/OpenAI-compatible-412991?style=for-the-badge&logo=openai&logoColor=white" alt="OpenAI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge" alt="MIT License" /></a>
</p>

<p>High quality AI-powered git commit messages that actually make sense.<br/>Analyzes your diffs, splits logical changes between both hunks and files, and writes Conventional Commits — all hands-free.<br/>Auto-stages if nothing is staged. Shows the plan, asks once, done.</p>

<br/>

</div>

---

## What is gitaicmt?

**gitaicmt** is a CLI tool that reads your staged git diffs, sends them to OpenAI, and produces clean, meaningful commit messages automatically. It can even split a big batch of staged changes into multiple logical commits — no manual message-writing required.

---

## Features

|     | Feature                       | Description                                                         |
| --- | ----------------------------- | ------------------------------------------------------------------- |
| 🧠  | **AI-generated messages**     | GPT analyzes your diffs and writes the commit message for you       |
| 🔀  | **Auto-split commits**        | Groups related changes into separate, logical commits               |
| 🧪  | **Hunk-level splitting**      | Splits unrelated changes within the same file into separate commits |
| 🚀  | **Fully automated**           | Auto-stages all changes if nothing is manually staged               |
| 📋  | **Plan mode**                 | Preview the commit split before executing anything                  |
| 📝  | **Conventional Commits**      | Follows the `type(scope): description` format by default            |
| ⚡  | **Parallel chunk processing** | Large diffs are chunked and analyzed concurrently                   |
| 🔧  | **Fully configurable**        | Model, temperature, subject length, body, language — all yours      |
| 🏗️  | **Pipe-friendly**             | `gitaicmt gen` outputs to stdout for scripting                      |

---

## Quick Start

### 1 · Install

```bash
bun install
bun run build
bun link
```

### 2 · Set your API key

```bash
export OPENAI_API_KEY="sk-..."
```

Or add it to `gitaicmt.config.json`:

```bash
gitaicmt init
```

Token usage is estimated before AI calls. The warning threshold is controlled by `analysis.tokenWarningThreshold`, defaults to `4000`, and can be set to `0` to disable the warning.

### 3 · Commit

```bash
gitaicmt
```

That's it. Changes are auto-detected, analyzed, split into logical groups, and committed with AI-written messages.

---

## Commands

| Command           | Alias | Description                                        |
| ----------------- | ----- | -------------------------------------------------- |
| `gitaicmt`        | `c`   | Auto-detect, split & commit (shows plan, asks y/n) |
| `gitaicmt -y`     |       | Same as above, skip confirmation                   |
| `gitaicmt plan`   | `p`   | Preview planned commit groups without committing   |
| `gitaicmt single` | `s`   | One commit message for all changes                 |
| `gitaicmt gen`    | `g`   | Generate message to stdout (for piping)            |
| `gitaicmt init`   |       | Create default `gitaicmt.config.json`              |
| `gitaicmt help`   | `-h`  | Show help                                          |

> Changes are auto-staged if nothing is manually staged.

---

## Examples

```bash
# Auto-split into logical commits (shows plan, asks y/n)
gitaicmt

# Same but skip the confirmation prompt
gitaicmt -y

# Preview the split before committing
gitaicmt plan

# Pipe a single message into git
gitaicmt gen | git commit -F -

# One commit for everything
gitaicmt single
```

---

## Configuration

Config is loaded and deep-merged in this order (last one wins):

1. `/etc/gitaicmt/config.json`
2. `~/.config/gitaicmt/config.json` (or `$XDG_CONFIG_HOME/gitaicmt/config.json`)
3. `./gitaicmt.config.json` (or `./.gitaicmt.json`)
4. `OPENAI_API_KEY` env var (highest priority — overrides config files)

Create a local config file:

```bash
gitaicmt init
```

---

## Stack

| Layer       | Technology         |
| ----------- | ------------------ |
| 🏎️ Runtime  | Bun                |
| 📜 Language | TypeScript 5       |
| 🧠 AI       | OpenAI (any model) |
| 🧪 Tests    | Bun test           |

---

## Project Structure

```
gitaicmt/
├── src/
│   ├── cli.ts      # CLI entry point & command routing
│   ├── ai.ts       # OpenAI integration & prompt building
│   ├── config.ts   # Config loading, merging & defaults
│   └── diff.ts     # Git diff parsing, chunking & staging
├── tests/
│   ├── ai.test.ts
│   ├── cli.test.ts
│   ├── config.test.ts
│   └── diff.test.ts
├── package.json
└── tsconfig.json
```

---

<div align="center">

Made with ❤️ by [Evan Schoffstall](https://github.com/evanschoffstall)

MIT License · Free forever · Let the robots write your commits

</div>
