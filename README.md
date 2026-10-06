# Pi ChatGPT usage

A read-only Pi extension showing your **Codex weekly allowance** and banked usage resets in Pi's existing status line below the prompt. It does not replace the footer or editor.

```text
Codex: 37%/wk. used · resets in 2d 4h · usage reset expiry dates: Oct 12, Oct 23
```

When the available reset count is zero it says `no usage reset available`. Missing data is labeled unavailable, not zero. If only the count is returned it shows the count and says expiry is unavailable; a complete inline expiry list implies the count without a redundant “2 available”. Partial or capped lists retain the authoritative available count explicitly. At most two expiry dates appear inline; longer/partial lists are labeled partial, and complete returned details remain available through the command. Null expiry dates mean no expiry or an unavailable expiry, not an invented date.

## Requirements and installation

- Pi with the `@earendil-works/pi-coding-agent` extension API (`ctx.mode`, `ctx.ui.setStatus`).
- Node.js 24 or newer for development tests.
- Codex CLI on PATH, signed in using **ChatGPT**, not an API key. Run `codex login` yourself if needed.

Tested with Codex CLI **0.160.0**, including a successful read-only live quota/reset probe. The app-server protocol is experimental; other versions may need an update.

Try without modifying settings:

```sh
pi -e ./index.ts
```

Install this directory as a Pi package if desired:

```sh
pi install /absolute/path/to/pi-chatgpt-usage
```

Reload or restart Pi after installation. No global install or user settings changes are performed by the extension.

## Commands and refresh

- `/chatgpt-usage` — cached details, including remaining percentage, complete weekly reset timestamp/timezone, other reported quota windows, reset-credit expiries and last successful fetch time.
- `/chatgpt-usage refresh` — request fresh usage and display details.

The first fetch starts asynchronously when an interactive TUI session starts. Usage is refreshed **every five minutes**; the relative countdown updates locally once per minute. Concurrent requests share one query. A query times out after 15 seconds and owns a temporary Codex app-server process, which is terminated afterward. Shutdown/reload cancels in-flight work and clears timers/status. There is no automatic querying in print, JSON or RPC modes.

The status uses Pi's normal footer layout, theme colors and width handling. Narrow terminals or many other status entries may shorten it; use the command for full details. Weekly percentages are used allowance, not message/token counts. The service reports percentages, not a fixed total. Only a reported seven-day window is called weekly; missing duration is not guessed. Dates use the machine's **local timezone**; command details include the timezone, while short credit expiry dates omit the year for compactness.

## Which account and quota?

The source is the account/workspace currently authenticated in **Codex CLI**, honoring `CODEX_HOME`. It can differ from the account used by Pi. The extension does not read credential files or synchronize logins, and does not display account emails or credit IDs.

This is the Codex allowance shown on the [ChatGPT Codex usage dashboard](https://chatgpt.com/codex/settings/usage), not a universal meter for ordinary ChatGPT chat, uploads, images or voice. Some plans share an agentic allowance between Codex and ChatGPT Work. See [OpenAI's quota explanation](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan).

Banked usage resets are **display-only**. The extension never redeems a reset, starts a Codex conversation, sends a model prompt, logs in/out, or changes configuration. The available reset count is authoritative; the service may supply fewer expiry detail rows than available resets. Quota and reset-credit read requests may let Codex refresh its own authentication normally.

## Errors and stale data

Missing CLI/login, unsupported API versions, network errors and malformed responses produce a compact unavailable/error status with a suggested action. If a refresh fails, the last successful snapshot is preserved and marked **stale** with its age; details include the error and last fetch time. A passed reset timestamp also marks the snapshot stale: it never pretends the quota has reset until fresh data confirms it. Retry with `/chatgpt-usage refresh`. Raw server errors/stderr are not displayed or stored.

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm pack --dry-run
git diff --check
```

Tests use synthetic quota fixtures, fixed time, mocked Pi lifecycle, and isolated Node child processes—no credentials, quota consumption or network access. Manual checks: load in Pi, inspect the below-prompt status and commands, resize to narrow widths, change theme, `/reload`, and exit; confirm there are no leftover owned Codex processes.
