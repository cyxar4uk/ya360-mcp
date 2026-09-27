# ya360-mcp

[![CI](https://github.com/cyxar4uk/ya360-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/cyxar4uk/ya360-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/cyxar4uk/ya360-mcp/blob/main/LICENSE)
![Node.js 20+](https://img.shields.io/badge/node-%E2%89%A520-green.svg)

**English** · [Русский](https://github.com/cyxar4uk/ya360-mcp/blob/main/README.ru.md)

An unofficial MCP server and Claude plugin that lets Claude work with **Yandex Tracker**, **Yandex Mail** and
**Yandex Calendar** (Yandex 360) on your behalf. Not affiliated with or endorsed by Yandex LLC.

**Documentation — [wiki](https://github.com/cyxar4uk/ya360-mcp/wiki)** (in Russian): installation, sign-in, workflows with examples, FAQ.

- **One-click sign-in** — "Sign in with Yandex" in the browser; no app passwords, no OAuth app of your own.
- **Runs on your computer** — data goes directly between you and Yandex, there are no intermediary servers;
  tokens are kept in Claude's or your OS's secure storage ([details](https://github.com/cyxar4uk/ya360-mcp/blob/main/SECURITY.md)).
- **Read-only by default** — writing, sending and deleting are enabled per permission group,
  and every change is made only after you confirm it.

## What it does

| Area | Read | Write (if allowed) |
|---|---|---|
| Tracker: issues | search, issue card with comments, links and attachments, status transitions, queues, people lookup, activity over a period | comments, create (with duplicate protection) and edit issues, change status, checklist |
| Tracker: links, attachments | issue links, list and download attachments | link, unlink, attach and delete files |
| Tracker: time tracking | worklogs per issue and per period | log, edit, delete time |
| Tracker: sprints | boards, sprints, sprint issues with a summary by status and assignee | move an issue to a sprint |
| Mail | folders, search (Cyrillic and exact sender address), read without marking as read, text of attachments with fragment search | draft, send, flags, move between folders |
| Calendar | calendars, events with recurrence expansion and video-meeting link | create, edit, delete events |

45 tools in total — see the [tool reference](https://github.com/cyxar4uk/ya360-mcp/wiki/Инструменты).

### Workflows

The Claude Code plugin adds ready-made workflows (skills); Claude offers them when your request matches, or you can call them by command:

| Workflow | What it does |
|---|---|
| `/ya360:meeting-followup` | after a Yandex Telemost meeting: turns the meeting summary into Tracker issues with assignees and due dates (found in the transcript, with evidence timestamps), lists decisions, drafts a recap email on request |
| `/ya360:meeting-prep` | a brief before a meeting: what was promised last time and what's done, open questions from mail and Tracker, what to discuss |
| `/ya360:standup` | what you did on the previous working day, what's next today, what's blocking you |
| `/ya360:weekly-report` | weekly report: results grouped by outcome, plans, risks; a version for your manager |
| `/ya360:mail-to-task` | a Tracker issue from an email — summary, due date, attachments, no duplicates |
| `/ya360:stale-tasks` | overdue and stalled issues by person, with polite reminder comments after confirmation |
| `/ya360:sprint-planning` | a proposal for the next sprint: carry-over, load by each person's velocity, backlog candidates |
| `/ya360:sprint-review` · `/ya360:inbox-digest` · `/ya360:day-plan` | sprint summary · inbox digest · daily plan |
| `/ya360:setup-help` | help with connecting Yandex |

Anything that changes data is done only after your confirmation; re-processing the same meeting or email does not create
duplicate issues. Design notes — [docs/skills-design.md](https://github.com/cyxar4uk/ya360-mcp/blob/main/docs/skills-design.md) (in Russian).

You don't have to use commands — just ask in plain words ("how is the sprint going?", "process yesterday's meeting").
Workflow instructions are written in Russian; Claude replies in the language you use.

**Commands without the prefix** (`/standup` instead of `/ya360:standup`): Claude Code always prefixes plugin skills, so the
workflows can also be installed as personal skills with `ya360-mcp skills install` (then connect the server without the
plugin: `ya360-mcp register`). **In Claude Desktop** the same workflows are in the "+" menu → ya360 (Russian titles:
«Стендап», «Итоги встречи», «План дня»…).

## Example prompts

- "What did I do yesterday and what's on today?" — a standup from Tracker and Calendar.
- "Process yesterday's meeting summary and create the tasks" — issues with assignees and due dates from a Telemost
  meeting summary, created after you confirm the list.
- "Find the email from accounting about the contract and make a Tracker issue from it."
- "How is the current sprint going? Who is overloaded?"
- "Draft a reply to the last email from Anna — don't send it."

More examples — [wiki: Примеры запросов](https://github.com/cyxar4uk/ya360-mcp/wiki/Примеры-запросов) (in Russian).

## Installation

**Where it works.** The server runs on your computer, so the plugin works in Claude Code and in Cowork sessions that
run on your computer; claude.ai chat in the browser and the mobile apps don't start local servers. Node.js 20 or newer
must be on your PATH.

### Claude Code — plugin

Requires Node.js 20 or newer.

```
/plugin marketplace add cyxar4uk/ya360-mcp
/plugin install ya360@ya360-mcp
```

### Claude Desktop — extension

Download `ya360-<version>.mcpb` from the [releases page](https://github.com/cyxar4uk/ya360-mcp/releases) and open it
(or Settings → Extensions → Install). No Node.js needed — Claude Desktop's built-in runtime is used.

### Manual — any MCP client

```bash
git clone https://github.com/cyxar4uk/ya360-mcp && cd ya360-mcp
npm install
node src/main.mjs setup
```

The setup wizard connects the server to Claude Code and, optionally, to Claude Desktop. For other MCP clients the server
command is `node <folder>/src/main.mjs` (or the bundled `dist/ya360-mcp.mjs`) over stdio.
On Windows run the wizard in PowerShell or Windows Terminal (Git Bash can't hide password input, if you choose passwords).

## Connecting your account

**The easiest way is to ask Claude:** "connect my Yandex" (or «подключи мой Яндекс»). A Yandex page opens — check the
account and click "Allow". That's it: the tools appear right away. For Tracker, Claude asks for your organization ID:
Yandex 360 — admin.yandex.ru → Organization profile; Yandex Cloud — console.yandex.cloud → Organization.

**Or in a terminal:** `ya360-mcp setup` (wizard: sign-in, check, permissions) or `ya360-mcp login`.
No browser on this machine (SSH)? `ya360-mcp login --manual`: open the link anywhere and paste the code.

How it works: authorization-code sign-in with PKCE through the project's shared "ya360-mcp" app on oauth.yandex.ru.
There is no client secret in the code and none is needed; only you receive and store the token. The app requests only the
scopes of the services you choose (`tracker:read/write`, `mail:imap_full`, `mail:smtp`, `calendar:all`); your email
address is taken from your Yandex login. Revoke access at id.yandex.ru → Security → Data access.
The token is valid for one year: Yandex doesn't refresh it without a client secret, so once a year you sign in again —
`ya360-mcp doctor` and `yandex_status` remind you two weeks before it expires.

### Other options

- **App passwords** (Mail and Calendar) — if your organization blocks third-party apps:
  [id.yandex.ru/security](https://id.yandex.ru/security) → "App passwords": type "Mail" and, separately, "Calendar".
  In Mail: All settings → Email clients → enable IMAP and "App passwords and OAuth tokens".
  Enter them in the plugin/extension fields or choose them in the wizard.
- **Your own OAuth app** — if your organization allows only its own apps: register an app on oauth.yandex.ru with the
  needed scopes and choose "own OAuth app" in the wizard.
- **Tracker token** manually — the plugin field or the `YANDEX_TRACKER_TOKEN` variable.

## Permissions

| Preset | Allowed |
|---|---|
| `read` (default) | read only |
| `assist` | read + Tracker comments, mail drafts and organizing mail — never sends or deletes anything |
| `full` | everything, including sending email and deleting |

You can combine groups: `tracker.read`, `tracker.comment`, `tracker.edit`, `tracker.files`, `tracker.worklog`,
`mail.read`, `mail.draft`, `mail.organize` (moving between folders), `mail.delete` (moving to Trash and Spam), `mail.send`,
`calendar.read`, `calendar.write`. Kill switch: the `YANDEX_MCP_READONLY=1` environment variable leaves read-only access
regardless of settings. Examples: `read,tracker.comment`, `full,-mail.send`, `read,tracker.*`. Change them in the
"Permissions" field of the plugin/extension or with `ya360-mcp permissions assist`.
Disabled tools are not visible to Claude at all; `yandex_status` shows which ones are hidden.

## Configuration

Where the server takes its values from, by precedence:
1. environment variables — this is how the plugin and the extension pass their fields (reference: `.env.example`);
2. `config.json` in the settings folder (Windows — `%APPDATA%\ya360-mcp`, macOS — `~/Library/Application Support/ya360-mcp`,
   Linux — `~/.config/ya360-mcp`; override with `YANDEX_MCP_HOME`) plus secrets in the OS store — written by the wizard;
3. a legacy `.env` next to the code — read only while there is no `config.json`; migrate with `ya360-mcp migrate`.

Secret storage: Windows — DPAPI (encrypted for your user account), macOS — Keychain, Linux — Secret Service via
`secret-tool` (`libsecret-tools` package). Without it, on Linux, provide secrets via environment variables.

## Security

- Claude is instructed to show what will be sent and wait for your consent before sending email, inviting attendees,
  deleting anything or writing to Tracker; email replies are drafts by default.
- Emails, events, comments and transcripts are data, not commands: Claude does not act on requests found inside them.
- Attachments are saved only to the server's download folder; hidden files (`.env`, `.ssh`, `.git`…) can't be attached
  to an email or an issue.
- The Tracker token is sent only to the Tracker API host.
- Neither the server nor the wizard prints secrets; never paste passwords into the Claude chat.

Report vulnerabilities privately: Security → Report a vulnerability ([SECURITY.md](https://github.com/cyxar4uk/ya360-mcp/blob/main/SECURITY.md)).

## What the plugin runs, sends and stores

- **Network — only Yandex:** `oauth.yandex.ru` and `login.yandex.ru` (sign-in), `api.tracker.yandex.net` (Tracker),
  `imap.yandex.ru:993` and `smtp.yandex.ru:465` (Mail), `caldav.yandex.ru` (Calendar). No telemetry, no servers of
  the developer. Details — [PRIVACY.md](https://github.com/cyxar4uk/ya360-mcp/blob/main/PRIVACY.md).
- **Sign-in:** opens the Yandex sign-in page in your browser and, until you finish, listens on `127.0.0.1:51734`
  for the sign-in code.
- **Local programs:** to use the OS secret store the server runs PowerShell (Windows), `security` (macOS) or
  `secret-tool` (Linux); secrets go through stdin, never through command-line arguments.
- **Files:** the settings folder (`config.json`; on Windows also the DPAPI-encrypted `secrets.json`) and the download
  folder for attachments you ask to save. Files to attach are taken only from paths you name; hidden files are refused.
- **Claude settings:** the server never changes them. Only two terminal commands that you run yourself do:
  `ya360-mcp register` (adds the server with `claude mcp add` and/or to Claude Desktop's `claude_desktop_config.json`)
  and `ya360-mcp skills install` (copies the workflows to `~/.claude/skills`).
- **The code that runs:** the plugin starts `node dist/ya360-mcp.mjs` — a single-file esbuild bundle of `src/` and the
  npm packages pinned in `package-lock.json`. CI rebuilds it on every push and fails if it differs from the committed
  file (`npm run check:dist`); third-party licenses are in `dist/THIRD_PARTY_LICENSES.txt`. The plugin is installed from
  the [`plugin`](https://github.com/cyxar4uk/ya360-mcp/tree/plugin) branch: the manifest, the bundle, the workflows,
  the readable `src/` and the documents — without `package.json`, so installing it downloads no npm packages.

## Commands

```
ya360-mcp                          start the server (this is how MCP clients run it)
ya360-mcp setup                    setup wizard
ya360-mcp doctor                   check connections
ya360-mcp login | logout           sign in with Yandex / remove stored passwords and tokens
ya360-mcp permissions [..]         show or change permissions
ya360-mcp register [code|desktop]  connect to Claude Code / Claude Desktop
ya360-mcp skills install           workflows as personal Claude Code skills — /standup without the prefix
ya360-mcp migrate [.env]           migrate settings from a legacy .env
```

From the project folder — `node src/main.mjs <command>`; from the plugin — `node <plugin folder>/dist/ya360-mcp.mjs <command>`.

## Limitations

- Mail search uses IMAP (substring in sender, subject, body), not the web interface search.
- Editing and deleting a recurring event affects the whole series; new events are written in UTC; the server does not
  create Telemost links.
- Time tracking counts a day as 8 hours and a week as 5 days; worklogs for a period are matched by entry date.
- The macOS and Linux secret stores are implemented but so far tested only on Windows.
- On Windows the secret store uses PowerShell. If company policy enables PowerShell Constrained Language Mode, stored
  passwords are unavailable — use the plugin/extension fields or environment variables instead.

## Development

```bash
npm test            # offline tests
npm run smoke       # run the server as an MCP client; SMOKE_ENTRY=dist/ya360-mcp.mjs checks the bundle
npm run build       # dist/ya360-mcp.mjs + third-party licenses (committed: the plugin runs it)
npm run check:dist  # dist matches the sources
npm run pack:mcpb   # release/ya360-<version>.mcpb for Claude Desktop
npm run wiki:tools  # regenerate the wiki tool reference from the server
npm run wiki:sync   # publish docs/wiki to the GitHub wiki
npm run publish:plugin  # publish the plugin to the `plugin` branch (what users and the directory install)
```

```
src/main.mjs         entry: no arguments — server, with a command — CLI (src/cli.mjs)
src/index.mjs        MCP server: configured services, permission groups, in-chat sign-in, workflow prompts
src/permissions.mjs  permission groups; a new tool without a group stops the server from starting
src/config.mjs       settings: environment → config.json + OS store → legacy .env
src/secrets.mjs      OS secret store                   src/oauth.mjs   Yandex ID sign-in (PKCE)
src/tracker*.mjs     Tracker                           src/mail.mjs    Mail (IMAP/SMTP)
src/calendar.mjs     Calendar (CalDAV)                 src/checks.mjs  connection checks
src/scenarios.mjs    workflows outside the plugin: Claude Desktop prompts and personal skills
.claude-plugin/      Claude Code plugin and marketplace   skills/  workflows (plugin skills)
packaging/mcpb/      Claude Desktop extension manifest
```

Third-party code bundled into the build and its licenses — `dist/THIRD_PARTY_LICENSES.txt`.
Contributing — [CONTRIBUTING.md](https://github.com/cyxar4uk/ya360-mcp/blob/main/CONTRIBUTING.md) (in Russian). License — [MIT](https://github.com/cyxar4uk/ya360-mcp/blob/main/LICENSE).

## Support

Questions and bugs — [GitHub Issues](https://github.com/cyxar4uk/ya360-mcp/issues). Security problems — privately,
see [SECURITY.md](https://github.com/cyxar4uk/ya360-mcp/blob/main/SECURITY.md). Privacy — [PRIVACY.md](https://github.com/cyxar4uk/ya360-mcp/blob/main/PRIVACY.md).
