# bsd-ims next phase: session profiles (handoff)

Version 0.3.0 is on `main`. Planning is done and no code has been written yet. Read `CLAUDE.md` first.

## Goal
Choose settings for each new chat from its task, so it starts without unneeded tools, skills, MCP servers or instruction files.

## Facts from the Claude Code docs (code.claude.com)
- A chat's tool list is fixed when it starts.
- A bare-name `permissions.deny` (settings file) or `--disallowedTools` (CLI) removes a tool's definition from context. A scoped rule such as `Bash(rm *)` only blocks matching calls.
- Settings files are watched while a chat runs:
  - If a deny rule is added during a chat and tool search is on (the default), the definition stays and only the call is blocked.
  - Removing the rule makes the tool usable again.
- CLI and Agent SDK settings for one session:
  - `--tools` (`""` = no built-in tools), `--disallowedTools`
  - `--settings <file or inline JSON>`, `--setting-sources`
  - `--strict-mcp-config` + `--mcp-config`
  - `--bare`, `--safe-mode`, `--disable-slash-commands`
  - In the SDK, `skills` takes a list of skill names.
- Skills: `"skillOverrides": { "<name>": "on" | "name-only" | "user-invocable-only" | "off" }`. Plugin skills are not affected by it.
- VS Code extension:
  - No per-chat settings. It reads the project's settings files, which every chat in that project shares.
  - `claudeCode.claudeProcessWrapper` sets the path to the program VS Code starts instead of `claude.exe`. It applies to all projects.
  - `claudeCode.environmentVariables` also applies to all projects.
  - `/mcp` in the panel enables or disables MCP servers.
- MCP tools already load as names only, so leaving them out saves little. The big parts are the built-in tool definitions, the skills list and CLAUDE.md.
- The docs don't say:
  - whether `--resume` with new `--tools`/`--settings` changes the tool list;
  - whether `setting_sources=[]` also leaves out `.claude/rules` and skills.

## Decided
- **Profiles** are JSON files in `<project>/.claude/bsd-ims/profiles/`, with keys named like the Agent SDK options.
- **Learn from past sessions (first, no AI):** per project, show what each tool, MCP server and skill costs at start against how often it was used. This gives a suggested profile.
- **Task first:** you type the task in the menu and get a suggested profile. It comes either from past usage (free) or from one Haiku call over the list of names only, logged in the Ask log. Both options are offered.
- **Start with nothing (mainly for learning):** the chat starts minimal, with an added instruction: "If you need a tool or skill you don't have, stop and tell me its name and why." What gets added is recorded, so profiles learn per kind of task.
- No Python/SDK example for now.

## Open: decide first
1. Which VS Code options to build when several chats of one project are open:
   - **A. Short-lived rules:** write the profile to `.claude/settings.local.json`, open a new chat, and put the file back as soon as bsd-ims sees the new session file. For a few seconds the other open chats can't use the blocked tools either.
   - **C. Launcher:** set `claudeCode.claudeProcessWrapper` to a small bsd-ims launcher. It adds `--settings <profile>` from a "next chat" profile picked in the menu, then starts the real `claude.exe`. This gives settings per chat in the panel, but it's untested on Windows, applies to all projects, and depends on how the extension starts claude.
   - **D. Terminal:** a copyable `claude --settings <profile>` command for VS Code's terminal. Per chat, but without the chat panel.
   - **B. One git worktree per task,** each in its own VS Code window with its own settings file. A README tip only.
2. Approve the automatic experiment (next section).

## Next steps
1. The owner answers the open points.
2. Write an automatic Windows PowerShell experiment script:
   - It runs `claude -p "Reply with OK."` in a test folder once per rule and flag, and compares each start-up breakdown with a baseline. The measuring uses the installed bsd-ims parser (`parseTranscript` from `npm root -g`\bsd-ims\src\show-context.mjs).
   - It measures:
     - what each rule removes: bare deny of a built-in tool, scoped deny, deny `mcp__<server>`, `disabledMcpjsonServers`, `skillOverrides` off / name-only, `claudeMdExcludes`, `--tools`, `setting_sources` empty;
     - whether a chat keeps its slim start after the rules are put back (option A);
     - whether `--resume` with a wider profile adds tools back;
     - a second baseline, to show the normal variation between chats.
   - It ends with numbered manual steps to check option C in the VS Code chat panel.
   - It saves a report with names and numbers only, never text, to the Desktop.
3. Adjust the plan to the results.
4. Build in this order, with E2E tests first and one commit per step:
   1. Past-usage statistics.
   2. Profiles and export.
   3. The chosen VS Code options.
   4. Task suggestions.
   5. The start-with-nothing loop.
