# yandex-mcp

MCP-сервер, через который Claude работает с **Яндекс Трекером**, **Почтой** и **Календарём**.
Локальный, по stdio: запускается клиентом (Claude Code, Claude Desktop) на вашей машине, ходит в API Яндекса
с вашими ключами из `.env`. Сервис без настроек просто не подключается — остальные работают.

| Сервис | Протокол | Инструменты |
|---|---|---|
| Трекер: задачи | REST API v3 | `tracker_whoami`, `tracker_list_queues`, `tracker_search_issues`, `tracker_get_issue` (по желанию с комментариями, связями, вложениями), `tracker_get_comments`, `tracker_get_transitions` · запись: `tracker_add_comment`, `tracker_create_issue`, `tracker_update_issue`, `tracker_transition_issue`, `tracker_set_checklist_item` |
| Трекер: связи | | `tracker_get_links` · запись: `tracker_link_issues`, `tracker_delete_link` |
| Трекер: вложения | | `tracker_list_attachments`, `tracker_download_attachment` · запись: `tracker_upload_attachment`, `tracker_delete_attachment` |
| Трекер: учёт времени | | `tracker_get_worklog`, `tracker_search_worklog` · запись: `tracker_add_worklog`, `tracker_update_worklog`, `tracker_delete_worklog` |
| Трекер: доски и спринты | | `tracker_list_boards`, `tracker_list_sprints`, `tracker_sprint_issues` (сводка по статусам и исполнителям) · запись: `tracker_set_sprint` |
| Почта | IMAP `imap.yandex.ru:993`, SMTP `smtp.yandex.ru:465` | `mail_list_folders`, `mail_search`, `mail_read`, `mail_save_attachment` · запись: `mail_create_draft`, `mail_send`, `mail_set_flags`, `mail_move` |
| Календарь | CalDAV `caldav.yandex.ru` | `calendar_list_calendars`, `calendar_list_events` · запись: `calendar_create_event`, `calendar_update_event`, `calendar_delete_event` |
| — | — | `yandex_status` — что подключено и каких настроек не хватает (без секретов) |

## Установка

```bash
cd C:/путь/к/yandex-mcp
npm install
cp .env.example .env    # и заполнить
npm test                # проверки без сети
npm run smoke           # поднять сервер как клиент MCP: список инструментов и yandex_status
npm run smoke -- tracker_whoami
```

## Доступы

**Трекер.** Если уже есть файл `.env.tracker`, достаточно указать путь к нему:
`YANDEX_TRACKER_ENV_FILE=…/.env.tracker` — токен и организация возьмутся оттуда. Иначе — `YANDEX_TRACKER_TOKEN`
(OAuth-токен приложения с правами `tracker:read` и `tracker:write`, oauth.yandex.ru) и `YANDEX_TRACKER_ORG_ID`
(Яндекс 360) либо `YANDEX_TRACKER_CLOUD_ORG_ID` (Yandex Cloud).

**Почта.**
1. Почта → Все настройки → Почтовые программы: включить «С сервера imap.yandex.ru по протоколу IMAP» и
   «Пароли приложений и OAuth-токены».
2. id.yandex.ru → Безопасность → Пароли приложений → создать пароль типа **«Почта»**.
3. В `.env`: `YANDEX_LOGIN` (полный адрес) и `YANDEX_MAIL_APP_PASSWORD`.

В организации Яндекс 360 доступ почтовых программ может быть выключен администратором — тогда IMAP не пустит.

**Календарь.** Там же создать пароль приложения типа **«Календарь»** (это отдельный пароль, почтовый не подойдёт)
и записать в `YANDEX_CALENDAR_APP_PASSWORD`.

## Подключение к Claude

**Claude Code** (терминал и вкладка Code в приложении) — один раз, для всех проектов:

```bash
claude mcp add --scope user yandex -- node C:/путь/к/yandex-mcp/src/index.mjs
```

Секреты в конфиг Claude не попадают: сервер сам читает `.env` из своей папки. После правки `.env` —
перезапустить сессию. Проверка: `claude mcp list`, в сессии — спросить «какие сервисы Яндекса подключены?»
(вызовет `yandex_status`).

**Claude Desktop, вкладка Chat** — в `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "yandex": { "command": "node", "args": ["C:/путь/к/yandex-mcp/src/index.mjs"] }
  }
}
```

## Безопасность

- `YANDEX_MCP_READONLY=1` — инструменты записи, отправки и удаления не подключаются вовсе.
- У инструментов есть пометки «только чтение / запись / удаление»: клиент спрашивает разрешение на запись,
  если вы не разрешили её заранее. Разрешать `mail_send` и `calendar_delete_event` навсегда не стоит.
- Сервер просит модель показывать письмо, приглашение или комментарий перед отправкой и по умолчанию
  класть письмо в черновики (`mail_create_draft`) — отправить можно самому из почты.
- Письма и события приходят от чужих людей: сервер помечает их как данные, а не команды.
- Вложения писем и задач сохраняются только в `YANDEX_MCP_DOWNLOAD_DIR` — выбрать другую папку модель не может.
- К письму или задаче нельзя приложить скрытый файл или файл из скрытой папки (`.env`, `.ssh`, `.git`…).
- Токен Трекера уходит только на хост его API, даже если адрес (например, ссылка на вложение) пришёл в ответе сервера.
- `.env` в `.gitignore`. `yandex_status` показывает, откуда взят токен, но не сами значения.

## Как устроено

```
src/index.mjs     сервер: подключает настроенные сервисы, yandex_status
src/config.mjs    .env, файл .env.tracker, проверка настроек
src/tracker.mjs   Трекер: клиент API (токен уходит только на хост API) и задачи
src/tracker-links.mjs · tracker-files.mjs · tracker-worklog.mjs · tracker-agile.mjs
                  связи · вложения · учёт времени · доски и спринты
src/mail.mjs      Почта: imapflow + mailparser (чтение без отметки «прочитано»), nodemailer
src/calendar.mjs  Календарь: tsdav (CalDAV) + ical.js; повторения раскрываются на стороне сервера
src/util.mjs      регистрация инструментов, HTML → текст, часовые пояса
test/unit.mjs     проверки без сети: время, разбор и сборка iCalendar, письма
test/smoke.mjs    живой прогон через клиент MCP
```

Время на входе без смещения (`2026-09-28T10:00`) понимается в поясе `YANDEX_TZ` (по умолчанию Europe/Moscow),
на выходе — в нём же. Дата без времени — событие на весь день.

## Ограничения

- Поиск почты — средствами IMAP (подстрока в отправителе, теме, теле), не поиском веб-интерфейса.
- `calendar_update_event` и `calendar_delete_event` у повторяющегося события действуют на всю серию.
- Учёт времени считает день за 8 часов, неделю за 5 дней (настройки Трекера по умолчанию); списания за период
  ищутся по дате внесения записи.
- Новые события пишутся во времени UTC; ссылку на Телемост сервер не создаёт.
- Пароли приложений, не OAuth, для почты и календаря: так проще и это официальный путь Яндекса для почтовых программ.
