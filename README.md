# BSD InspectMySession (`bsd-ims`)

**See what fills a Claude Code session's context window, and where each answer came from. Made to work on Windows.**

BSD InspectMySession is an unofficial utility for inspecting Claude Code sessions. It is not affiliated with or endorsed by Anthropic.

It opens one local web page with a menu of all your Claude Code sessions, grouped by project. For the session you pick it shows what loaded at session start (system prompt, tools, CLAUDE.md files, skills, MCP), then every file, search, MCP result, skill and web page the session read, sized by real token use, and the whole conversation.

## Credit and relationship to upstream

This project is a derivative of [show-context](https://github.com/bernatsampera/show-context) by its contributors (version 0.2.1, MIT license). Nearly all of the code is theirs. This fork renames the command and adds the changes listed below; it is not the original project and is not endorsed by its author. The upstream license and copyright notice are kept in [LICENSE](LICENSE).

To pick up upstream fixes in a clone: `git remote add upstream https://github.com/bernatsampera/show-context` (if not already set), then `git fetch upstream` and `git merge upstream/master`.

![Show context mode: start load parts and session reads](docs/screenshot.png)

*Screenshot from the upstream project. It does not show the per-tool rows added here.*

## What is different from upstream

- **Opens the page on Windows and Linux.** Upstream called the macOS `open` command. `bsd-ims` uses `rundll32` on Windows, `open` on macOS and `xdg-open` elsewhere.
- **Finds the session for the current folder on Windows.** Project folders are matched with every non-alphanumeric character of the path replaced by `-` (for example `C:\projects\sdlc` → `C--projects-sdlc`). Upstream only replaced `/` and `.`.
- **No console window flash** when the live server starts on Windows.
- **Finds `claude.exe` on Windows** for *Where did this come from?* (`%USERPROFILE%\.local\bin\claude.exe`).
- **Works with VS Code sessions** (their main request is labelled `sdk`) and with sessions that start with an API error.
- **Per-tool sizes.** The Tools part of the start-up view lists every tool with its own size.
- **One server and a session menu.** Upstream starts a new server for every page. Here one local server serves a menu of all sessions, grouped by project, and every session page.
- **Dark theme by default**, with one button that switches the menu and the session page together.
- ***Where did this come from?* shows a waiting popup** with a timer and **Cancel**, names the model it uses, and reports the tokens and cost of each answer.
- **Settings and Ask log tabs.** Choose the model for questions (by default chosen automatically from the cache state) and see every question with its cost.
- **Install and test scripts for Windows** (`scripts/windows/`).
- **Transcript contract and checker** (`contract/`) that tell you when a Claude Code update changes the transcript format.
- The command is `bsd-ims`, so it installs next to `show-context` without a clash. The environment variables keep their `SHOW_CONTEXT_*` names. Pages are written to `~/.cache/bsd-ims/` (upstream uses `~/.cache/show-context/`).

## Status

The automated tests pass on Linux. Version 0.1 was tested on Windows 10 with PowerShell 7 and Claude Code 2.1.327: opening the page, matching the current folder, per-tool sizes and *Where did this come from?* all worked. The session menu, the single server, the theme button and the waiting popup (version 0.2) were tested on Windows on 2026-11-26. The Settings and Ask log tabs and the automatic model choice are new and not yet tested on Windows.

## Install or update (Windows)

Requires Node.js 22 or later. No dependencies, and git is not needed. In PowerShell 7:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/Bsd-AI-Dev/BSD-InspectMySession/main/scripts/windows/install.ps1 -OutFile $env:TEMP\bsd-ims-install.ps1; pwsh -ExecutionPolicy Bypass -File $env:TEMP\bsd-ims-install.ps1
```

`scripts/windows/install.ps1` checks Node.js, stops running bsd-ims servers, downloads the latest `main` from GitHub, installs it with npm from the downloaded file (recent npm versions refuse to install from a web address with `EALLOWREMOTE`), and checks the result. Run the same command to update. To remove: `npm uninstall -g bsd-ims`.

**Older version.** Version 0.1, with the PowerShell session picker instead of the web menu, is kept on the `version-0.1` branch. Install it by adding `-Branch version-0.1` at the end of the command above.

For development, from a clone: `git clone https://github.com/Bsd-AI-Dev/BSD-InspectMySession`, then `npm link` in that folder. The package is not published on npm.

### Test on Windows

`scripts/windows/bsd-ims-test.ps1` installs or updates bsd-ims, opens the newest session of a project folder, checks that only one server runs, asks a few yes/no questions, runs the transcript checker, and saves a report to `bsd-ims-test-report.txt` on your Desktop:

```powershell
Invoke-WebRequest https://raw.githubusercontent.com/Bsd-AI-Dev/BSD-InspectMySession/main/scripts/windows/bsd-ims-test.ps1 -OutFile $env:TEMP\bsd-ims-test.ps1; pwsh -ExecutionPolicy Bypass -File $env:TEMP\bsd-ims-test.ps1 -ProjectFolder 'C:\projects\sdlc'
```

Change `C:\projects\sdlc` to a folder where you used Claude Code.

By default it asks only about what is still open from the last test. Add `-Full` at the end to go through every question and check your 5 newest sessions.

## Use

### The session menu

Go to a folder where you used Claude Code and run:

```powershell
bsd-ims
```

Your browser opens a page with a menu on the left: all sessions, grouped by project, newest first, with date, source (`vsc` for the VS Code extension, `cli` for the terminal), size and first message. The newest session of the current folder is selected and shown on the right. You can:

- click any session to show it on the right;
- filter by text, project, date or id, and by source;
- copy a session's transcript path (**Copy path**);
- reload the list (**Refresh**) and stop the server (**Stop server**);
- switch both the menu and the session page between dark and light (**Light theme** / **Dark theme**).

The menu has three tabs: **Sessions** (above), **Settings** and **Ask log**.

### Asking *Where did this come from?*

Select text in the Conversation view and click *Where did this come from?*. A popup shows which model is used and why, and a timer; **Cancel** stops the question. The answer card shows the model, the tokens (read from cache, written to cache, new, output) and the cost Claude Code reported. If a cheaper model found no source, **Try again with** asks again with the session's own model.

**Which model answers.** The question runs on a copy of your whole session. Anthropic keeps the session in its cache for 5 minutes or 1 hour after its last request, and only for the same model. In **Auto** (the default), bsd-ims estimates the cost with the session's model: while the cache is warm that is a few cents, so the session's model is used; once it has expired it is often 5 to 25 times more than Haiku 5.5, so Haiku 5.5 is used when the estimate is over the cost limit ($0.10 by default). No AI is involved; the rule only uses the time of the session's last request, its size, its model and the price table.

**Settings tab:** model for questions (Auto, the session's model, a fixed model, or any model id), cache lifetime (read from the session, or 5 minutes / 1 hour), cost limit, time limit per question, whether the ask log keeps the question text, and the price table used for estimates. Settings are saved in `~/.cache/bsd-ims/settings.json`.

**Ask log tab:** every question, newest first, with model, cost and result. Click one for its details: why that model was chosen, the estimate made before asking, and the tokens and cost per part. The log is `~/.cache/bsd-ims/asks.jsonl` and stays on your computer. With a Claude subscription the dollar amounts are what Claude Code reports; you are not charged them, they count toward your usage limits.

One local server serves the menu and all session pages. Running `bsd-ims` again reuses it. It stops by itself after an hour without use, or with **Stop server** or `bsd-ims --stop`. Each session page is rebuilt from its transcript when you open it.

### Command line

```powershell
bsd-ims <session-id-or-prefix>
```

Without an id it selects the session in `CLAUDE_CODE_SESSION_ID` if set, otherwise the newest session started in the current folder.

| Option | What it does |
| --- | --- |
| `--no-open` | Print the live URL, don't open the browser |
| `--static` | Write a static page of this session only, no local server (*Where did this come from?* does not work there) |
| `--stop` | Stop the live server |
| `--help` | Show all options and environment variables |
| `--version` | Show the version |

### Environment variables

| Variable | Meaning |
| --- | --- |
| `SHOW_CONTEXT_OUT` | Output file. Default `~/.cache/bsd-ims/bsd-ims.html` |
| `SHOW_CONTEXT_PROJECTS` | Claude projects folder. Default `~/.claude/projects` |
| `SHOW_CONTEXT_PORT` | Port of the live server. Default: a random free port |
| `SHOW_CONTEXT_IDLE_MS` | Live server idle timeout. Default 1 hour |
| `SHOW_CONTEXT_CLAUDE_BIN` | Claude Code binary for *Where did this come from?*. Default: `%USERPROFILE%\.local\bin\claude.exe` on Windows if it exists, otherwise `claude`. Node cannot start a `.cmd` shim, so on Windows point it at a `claude.exe` |

## Privacy and how it works

- It reads local session transcripts and never changes them. The menu reads only the start of each transcript (title, folder, source).
- The live server binds to `127.0.0.1` only, and every route needs a random 32-byte token. Its address is kept in `~/.cache/bsd-ims/server.json`. `--static` writes a single self-contained HTML file instead.
- Token counts come from the real input token use of each model call. When several items enter one call together, the increase is split by their character count.
- **Only *Where did this come from?* uses the network.** It runs your local Claude Code CLI on a fork of the session with no tools, and costs tokens like any Claude Code call. The fork is not saved, and your session stays untouched.

## Transcript checker

`bsd-ims` depends on Claude Code's transcript format, which is not documented and can change. `contract/transcript-contract.json` lists every field, record type, attachment type, tool name, text marker and `claude` CLI flag the code relies on, and what breaks if it changes. `contract/check-transcript.mjs` checks real transcripts against it, runs the parser on them, and checks `claude --help` for the flags the ask feature uses.

After the install above, the checker is in the installed folder:

```powershell
node "$(npm root -g)\bsd-ims\contract\check-transcript.mjs" --latest 5
```

From a clone: `node contract/check-transcript.mjs --latest 5`.

(In a clone, `npm run check -- --latest 5` does the same.) Exit code 0 means OK, 1 warnings, 2 failures.

- **First run:** the checker lists record, attachment, block and tool types it does not know as INFO. Look at them once. If there are no FAIL lines and nothing looks important, run it again with `--stamp`. That records the Claude Code version and marks those types as reviewed, so later runs only show new changes.
- `--fix-prompt` prints a ready-made prompt that describes the problems for Claude Code.
- Other options: `--json`, `--no-parse`, `--no-cli`, `--projects`, `--src`, `--contract`. See `--help`.

### When Claude Code updates

1. Run the checker as shown above.
2. If it reports WARN or FAIL, run it again with `--fix-prompt` and give the output to Claude Code in this repository.

## Limits

- It depends on an unofficial transcript format, which can change without notice. Use the checker above.
- Subagent reads are not shown.
- Per-tool sizes are estimates: the measured Tools total is split by the length of each tool's definition. The Instructions breakdown uses the same method.
- The Tools and System prompt parts need `api-request-shape` records in the transcript. Sessions without them show *Not recorded in this session file* instead.
- `Grep` and `Glob` tool results are not counted as reads.
- *Where did this come from?* works with Claude Code only.

## License

MIT. See [LICENSE](LICENSE). The original copyright notice of show-context is kept; changes in this fork are additionally copyright Bsd-AI-Dev.
