# Changelog

All notable changes to this project are documented here. Versions follow
[SemVer](https://semver.org/); tags live in this repository.

> Fork lineage: [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
> (original) → [psyrtsov](https://github.com/psyrtsov/dsh-telegram-channel)
> (English UI) → **[andrepontesmelo/dsh-telegram-channel](https://github.com/andrepontesmelo/dsh-telegram-channel)**
> (this fork).

## 0.4.0 — 2026-09-11

- **English UI** for all bot strings (via psyrtsov).
- **Fork: `/new` command** (alias `/create`) — creates a brand-new blank
  session via the Web's `session.create` RPC and attaches it instantly;
  targets the currently bound workspace, otherwise reuses the workspace
  picker in create mode. (4ee1609, 11b847e)
- **Fork: skill gesture passthrough** — unknown slash commands are forwarded
  verbatim into the bound session as user messages, so DSH skills can be
  invoked from the phone (e.g. `/wayfinder …`). (81cd7f8)
- **Fork: typing keepalive** — the typing indicator is sustained with a 4s
  keepalive while a turn is busy. (2ab2529)
- Rebuilt committed `lib/` from `src/` — the shipped entry point had drifted.
  (28d52cd)

## 0.3.5 — 2026-08-18

- Use Telegram native Rich Message for assistant replies.
- Stabilize `/model` reasoning-effort selection.

## 0.3.4 — 2026-08-14

- `/last` command and bind button to fetch the previous Q/A context.

## 0.3.3 — 2026-08-14

- Warn when `/sessions` falls back to a live-only list.

## 0.3.2 — 2026-08-14

- Resolve `apiProxy` via `ctx.get` for `/model` (works without inject).

## 0.3.1 — 2026-08-14

- Approve git installs with pnpm repo-level `allowBuilds`.

## 0.3.0 — 2026-08-14

- Workspace→session picker aligned with the Web (archived sessions excluded).
- `/model` command to switch the bound session's model for the next turn.

## 0.2.3 — 2026-08-14

- Show session title and workspace in the `/sessions` picker.

## 0.2.2 — 2026-08-14

- One-click installer scripts (`install.sh` / `install.ps1`) with a number
  menu: install / start / stop / status; honor `HTTP(S)_PROXY` for Telegram.

## 0.2.1 — 2026-08-14

- Ship prebuilt `lib/` and drop the `prepare` script so one-click git
  installs work.

## 0.2.0 — 2026-08-14

- Remote-control live DSH Web sessions from Telegram: attach to a running
  session and share the same trajectory, bidirectionally visible.

## 0.1.0 — 2026-08-14

- Initial release: Telegram Bot API client with token redaction, auth gate,
  Chinese command parsing, HTML formatting/splitting, bridge to harness
  agents, Cordis apply lifecycle with soft-fail token check, configurable
  `pollingTimeoutSec`, bilingual README.
