# Privacy policy

**English** · [Русский](#политика-конфиденциальности)

Effective: 27 September 2026. Applies to ya360-mcp — the MCP server, the Claude plugin `ya360`, the Claude Desktop
extension and the `ya360-mcp` command-line tool. ya360-mcp is an unofficial open-source project, not affiliated with
or endorsed by Yandex LLC.

## Summary

- ya360-mcp runs **on your computer**. The developer runs no servers for it and receives **none** of your data or tokens.
- It connects **only to Yandex**, with your own account, and only when Claude calls one of its tools.
- There is **no telemetry**: no analytics, usage statistics or crash reports.

## What it accesses

When you ask Claude to, ya360-mcp reads or changes data in your Yandex account:

- **Yandex Tracker** — issues, comments, links, attachments, time tracking, boards and sprints, users of your organization;
- **Yandex Mail** — folders, messages and attachments; drafts and sending;
- **Yandex Calendar** — calendars and events.

What each tool may do is limited by permission groups (read-only by default). Tool results are passed to the Claude app
you use; there they are handled under [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

## Where data is sent

Directly from your computer to Yandex, over TLS:

| Host | Purpose |
|---|---|
| `oauth.yandex.ru` | sign-in with Yandex ID and token exchange |
| `login.yandex.ru` | your login name and address after sign-in |
| `api.tracker.yandex.net` | Tracker API |
| `imap.yandex.ru:993`, `smtp.yandex.ru:465` | reading and sending mail |
| `caldav.yandex.ru` | Calendar (CalDAV) |

Yandex processes these requests under its own terms and privacy policy. Nothing is sent anywhere else.

Sign-in uses the project's shared OAuth app "ya360-mcp" on oauth.yandex.ru. The token is issued to your computer only:
the app has no client secret, and the developer can't see or use your token.

## What is stored on your computer

- **Settings** — `config.json` in the settings folder (Windows `%APPDATA%\ya360-mcp`, macOS
  `~/Library/Application Support/ya360-mcp`, Linux `~/.config/ya360-mcp`): login, organization ID, time zone,
  permissions. No passwords or tokens.
- **Secrets** — OAuth tokens and app passwords: in the Claude plugin/extension fields (Claude keeps them in secure
  storage), or in your OS store — Windows DPAPI (`secrets.json`, encrypted for your user account), macOS Keychain,
  Linux Secret Service.
- **Attachments** you ask to save — in the download folder (by default the `ya360-mcp` folder in the system temp
  directory).

While you sign in, a local web server listens on `127.0.0.1:51734` to receive the sign-in code, and stops afterwards.

## Retention and deletion

ya360-mcp keeps nothing beyond the files above. To remove everything:

1. run `ya360-mcp logout` (removes stored passwords and tokens) or clear the plugin/extension fields;
2. delete the settings folder and the download folder;
3. revoke access at [id.yandex.ru](https://id.yandex.ru/) → Security → Data access ("ya360-mcp").

## Children

ya360-mcp is a work tool and is not intended for people under 18.

## Changes and contact

Changes to this policy are published in this file; its history is in the repository.
Questions — [GitHub Issues](https://github.com/cyxar4uk/ya360-mcp/issues); security problems — privately, see
[SECURITY.md](SECURITY.md).

---

# Политика конфиденциальности

Действует с 27 сентября 2026 г. Относится к ya360-mcp — MCP-серверу, плагину Claude `ya360`, расширению Claude Desktop
и консольной программе `ya360-mcp`. Это неофициальный проект с открытым кодом, не связанный с ООО «Яндекс».

- ya360-mcp работает **на вашем компьютере**. У разработчика нет серверов для него, ваши данные и токены к нему
  **не попадают**.
- Соединения — **только с Яндексом** (адреса — в таблице выше), от вашего имени и только когда Claude вызывает инструмент.
- **Телеметрии нет**: ни аналитики, ни статистики, ни отчётов об ошибках.
- Что доступно: задачи, комментарии, вложения, учёт времени и спринты Трекера; письма и вложения Почты; события
  Календаря. Что можно делать — ограничено группами прав (по умолчанию только чтение). Результаты инструментов уходят
  в приложение Claude, где действует [политика Anthropic](https://www.anthropic.com/legal/privacy).
- Вход — через общее приложение «ya360-mcp» на oauth.yandex.ru; токен выдаётся только вашему компьютеру, секрета
  у приложения нет, разработчик ваш токен не видит.
- Что хранится у вас: `config.json` в папке настроек (без паролей и токенов); токены и пароли — в полях плагина или
  расширения (их хранит Claude) либо в хранилище ОС; сохранённые по вашей просьбе вложения — в папке загрузок.
  Во время входа на `127.0.0.1:51734` ненадолго запускается локальный сервер для кода входа.
- Как удалить всё: `ya360-mcp logout`, удалить папку настроек и папку загрузок, отозвать доступ в id.yandex.ru →
  Безопасность → Доступ к данным.
- Не предназначено для лиц младше 18 лет.
- Вопросы — [GitHub Issues](https://github.com/cyxar4uk/ya360-mcp/issues), уязвимости — [SECURITY.md](SECURITY.md).
