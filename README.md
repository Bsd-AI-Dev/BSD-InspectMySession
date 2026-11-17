# show-context

show-context creates one local page that shows what a Claude Code session read.

![A show-context page with start load parts and session reads](docs/screenshot.png)

## What the page shows

The page shows the parts loaded at the start of the session.
It then shows each read in order.
The block height grows with the read size.
Each color identifies File, Explore, MCP, Skill, or Web content.
Select a row to see its full text.
The size filter hides rows smaller than 2,000 tokens by default.

## Install

Install the command with npm.

```text
npm install -g show-context
```

You can also run it without an install.

```text
npx show-context
```

Install it from source.

```text
git clone https://github.com/bernatsampera/show-context.git
cd show-context
npm link
```

Node.js 24 or later is required.

## Use

Run this command inside Claude Code.

```text
! show-context
```

Run this command in a terminal to select a session by ID or prefix.

```text
show-context <session-id-or-prefix>
```

Use `--no-open` to write the page without opening it.
Set `SHOW_CONTEXT_OUT` to select another output file.
Set `SHOW_CONTEXT_PROJECTS` to select another Claude projects folder.
The old `CONTEXT_LENS_ROOT` name still works as a fallback.

The default output is `~/.cache/show-context/show-context.html`.

## How it works

The command reads one local transcript.
It does not use the network.
It does not run in the background.
It does not change the Claude projects folder.

The command measures input tokens from each model call.
This value is exact for that call.
When several items enter the call together, the command divides the increase by the character count of each item.

Reads include files, shell file reads, shell searches, MCP reads, skills, and web results.
Writes, edits, and run commands are not reads.
The page keeps all CSS, JavaScript, data, and icons in one local HTML file.

## Limits

The parser depends on the Claude Code transcript format.
That format can change.
The page does not show subagent reads.

## License

MIT
