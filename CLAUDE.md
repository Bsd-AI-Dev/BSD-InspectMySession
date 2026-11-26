# BSD InspectMySession (`bsd-ims`): notes for Claude Code

## What this is
- A Windows-friendly derivative of [show-context](https://github.com/bernatsampera/show-context) (MIT, upstream 0.2.1, commit `0e3890e`). Most code is upstream's. Keep the upstream copyright line in `LICENSE` and the credit section in `README.md`.
- Unofficial utility for inspecting Claude Code sessions; not affiliated with Anthropic. No Anthropic/Claude logos or branding, and no "Claude" or "Anthropic" in package or command names.
- Command and package name: `bsd-ims`. Not published on npm; installed from the GitHub archive.
- Remotes: `origin` = this repo, `upstream` = show-context (default branch `master`). Keep upstream's files as untouched as possible so `git merge upstream/master` stays easy.

## Rules
- Node.js 22+ built-ins only. **No npm dependencies.**
- **Write or update the E2E test first**, then the code. No unit tests.
- Run the tests: `CHROME_PATH=/opt/pw-browsers/chromium npm test` (in this kind of cloud container; elsewhere any Chrome/Chromium). Don't set `UPDATE_SCREENSHOTS`.
- Smallest change that does the job; no unrelated refactors or reformatting.
- One commit per logical step. The owner tests on Windows; don't claim anything Windows-only works until their test report says so.

## Layout
- `bin/bsd-ims.mjs`: CLI. Picks the session (id prefix, `CLAUDE_CODE_SESSION_ID`, or newest in the current folder), writes the static page, finds or starts the live server, opens the browser (`rundll32` / `open` / `xdg-open`). `--stop`, `--static`, `--no-open`, internal `--serve <stateFile> <key>`.
- `src/server.mjs`: one local server for all sessions. Routes under `/<token>/`: `` (menu), `api/ping`, `api/sessions`, `s/<id>/` (session page), `s/<id>/ask`, `stop`. Idle timeout 1 h (never during an ask). POST routes check `Origin`.
- `src/menu-page.mjs`: the menu (sessions grouped by project, filters, Copy path, Refresh, Stop server). The session page is shown in an iframe, unchanged.
- `src/sessions.mjs`: projects root, session list, per-session title/cwd/source read from the first 2 MB of a transcript.
- Upstream files, mostly unchanged: `src/show-context.mjs` (parser), `src/start-load.mjs` (start-up breakdown), `src/show-context-page.mjs`, `src/show-context.client.js`, `src/show-context.css`, `src/agents/claude.mjs` (ask via `claude --resume … --fork-session --print`).
- The server address is kept in `server.json` next to the output page (default `~/.cache/bsd-ims/`). It is reused only when the version, projects root and all `SHOW_CONTEXT_*` variables (except `SHOW_CONTEXT_OUT`) match.
- `contract/`: `transcript-contract.json` (what the code relies on in the transcript format), `check-transcript.mjs` (checks real transcripts), `outline-transcript.mjs` (prints a transcript's structure with no text, safe to share). When code that the contract references moves or changes, update its `usedBy`/`search` strings and check that every `search` string still exists in `src/` or `bin/`.
- `scripts/windows/install.ps1` (install/update from GitHub, `-Branch`), `scripts/windows/bsd-ims-test.ps1` (Windows test run that writes a report to the Desktop).

## Decisions already made
- Environment variables keep their `SHOW_CONTEXT_*` names. Output goes to `~/.cache/bsd-ims/`.
- Version 0.1 (the PowerShell session picker instead of the web menu) is kept on branch `version-0.1`. This environment could not push git tags, so versions are kept as branches.
- Per-tool sizes in the Tools part are estimates: the measured total split by each tool definition's JSON length.
- `Grep` and `Glob` results are not counted as reads yet (listed as `knownGaps` in the contract). Ask the owner before changing this.
- `contract/` is not in the npm `files` list, but installs from the GitHub archive include the whole repo, so the checker is available in the installed folder.

## Learned from real Windows transcripts (Claude Code 2.1.327, VS Code extension)
- Project folders use every non-alphanumeric character replaced by `-`, and the drive letter can be lowercase (`c--projects-x`). Folder matching therefore ignores case.
- VS Code sessions label the main API request `querySource: "sdk"`; the terminal uses `repl_main_thread`. Both count as the main request.
- A session can start with a synthetic assistant message (`isApiErrorMessage`, model `<synthetic>`, zero usage). Such messages are ignored when measuring.
- `entrypoint` is present (`vscode` → shown as `vsc`). `claude.exe` is usually at `%USERPROFILE%\.local\bin\claude.exe`.
- npm 12 refuses `npm install -g <web address>` (`EALLOWREMOTE`); download the archive first and install the file.

## Working with the owner
- They test on Windows 10/11 with PowerShell 7 and prefer complete scripts and numbered steps over separate commands.
- For a Windows check, update `scripts/windows/bsd-ims-test.ps1` and give them the one-line command from the README; they send back the report file.
- For transcript-format problems, ask them for `outline-transcript.mjs <session-id>` output, never for transcript content.
