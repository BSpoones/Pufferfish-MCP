# Pufferfish-MCP

An MCP server for controlling Coral game panels — Coral is the panel software also known as "Pufferfish" — power, console commands, files, backups, SFTP, and server listing. Multi-panel aware — tools resolve servers by name across every panel you've added.

**Coral is not Pterodactyl.** This project shares an architecture (and some code shape) with Pterodactyl-MCP, but it is not a fork wired up to the same API — Coral's client API (`/api/v2/client/...`) is a different, incompatible surface from Pterodactyl's. Endpoint paths, response shapes, and available actions all differ; don't assume anything documented for Pterodactyl-MCP applies here.

> **⚠️ Not yet verified against a live panel.** This server was written against Coral's published swagger spec only — it has not been built and run end-to-end against a real Coral instance. Expect API-shape mismatches once you try it for real, especially around `list_files` and `list_backups` response field names, which could not be fully confirmed from the spec alone. Treat the first real run as a debugging session.

## Setup

**1. Build** (Node 22+):

```
npm install
npm run build
```

This produces `dist/server.js` (the MCP server entry point) and `dist/cli.js` (the `pufferfish-mcp` CLI).

**2. Get a Client API key.** Log into your Coral panel account and look for an API keys page under your account settings (the exact path isn't confirmed — check your panel's account settings for an "API keys" page). Create a key there; it acts as you, scoped to whatever servers your account can see. Repeat per panel if you use more than one.

**3. Register the MCP server with your panel(s) as environment variables.** This is the primary, recommended way to configure panels — no CLI flags or files to manage. Each panel is declared with two env vars: `PUFFERFISH_<ALIAS>_URL` and `PUFFERFISH_<ALIAS>_KEY`, where `<ALIAS>` is whatever short name you want to refer to that panel by (e.g. `PROD`, `SURVIVAL`).

Using the Claude Code CLI:

```
claude mcp add --scope user pufferfish -e PUFFERFISH_PROD_URL=https://panel.example.com -e PUFFERFISH_PROD_KEY=XXXX -e PUFFERFISH_DEFAULT_PANEL=prod -- node /path/to/Pufferfish-MCP/dist/server.js
```

Or the equivalent raw JSON, if you're editing the MCP settings file directly:

```json
{
  "mcpServers": {
    "pufferfish": {
      "command": "node",
      "args": ["/path/to/Pufferfish-MCP/dist/server.js"],
      "env": {
        "PUFFERFISH_PROD_URL": "https://panel.example.com",
        "PUFFERFISH_PROD_KEY": "XXXX",
        "PUFFERFISH_DEFAULT_PANEL": "prod"
      }
    }
  }
}
```

Add more panels by repeating the pattern with a different alias, e.g. `PUFFERFISH_SURVIVAL_URL` / `PUFFERFISH_SURVIVAL_KEY`. Aliases are lowercased automatically and must otherwise look like `[a-z0-9][a-z0-9_-]*`.

Plus one server-wide variable: `PUFFERFISH_DEFAULT_PANEL` sets which panel alias tools use when they omit `panel` and more than one panel is configured. If exactly one panel is configured, it's used automatically even without a default set.

**4. Verify:**

```
node dist/cli.js doctor
```

Checks each configured panel: authenticates against the client API and lists visible servers, and prints whether each panel's config came from environment variables or the config-file fallback (see below). Pass an alias (`doctor prod`) to check just one panel. Exits with status 1 if any panel fails.

### Optional: config-file fallback

If you'd rather not put keys in your MCP settings, `add-panel` writes panels to a local config file instead (`~/.pufferfish-mcp/config.json` by default, override with `PUFFERFISH_MCP_CONFIG`):

```
node dist/cli.js add-panel prod --url https://panel.example.com --client-key XXXX --default
```

Env vars and the config file can be used together — for any given panel alias, env vars win on a per-field basis. The config file is created with restrictive permissions (owner-only, via `chmod 0600` on Unix or `icacls` on Windows).

## MCP tools

| Tool | Description |
|---|---|
| `list_panels` | List configured Coral panels: alias, base URL, whether a client key is set, and which panel is the default. Never prints the actual key value. |
| `list_servers` | Lists servers visible to the configured key(s). With no panel given, searches every configured panel. |
| `server_resources` | Gets live resource utilization (CPU, memory, disk, network, uptime) for a server. |
| `power` | Sends a power action (`start`, `stop`, `restart`, `kill`) to a server. With `wait: true`, polls resource state every 3s (up to 120s) until the server reaches the expected end state, then reports the final state and elapsed time. |
| `send_command` | Sends a console command to a running server. Fire-and-forget — no output capture. |
| `list_files` | Lists files and directories at a path on a server. |
| `read_file` | Reads a file's contents from a server. Large files are truncated. |
| `write_file` | Overwrites a file's contents on a server. Destructive — requires `confirm: true`. |
| `list_backups` | Lists backups for a server. |
| `create_backup` | Creates a new backup for a server (optional `name`, `locked`). |
| `sftp_transfer` | Uploads/downloads a file or directory (recursively) over SFTP. Use for large files or bulk transfers; `write_file` is simpler for small files. |
| `sftp_setup` | One-time SFTP setup for a panel: generates and registers an ed25519 SSH key (`mode: "key"`, recommended), or verifies a configured password works (`mode: "password"`). Run once per panel before the first `sftp_transfer`. |

All server-targeting tools accept a `server` argument — `"alias:name-or-id"`, a full UUID, a UUID-short identifier, or a unique (case-insensitive, substring-matched) server name — plus an optional `panel` argument to restrict/select which panel to search.

### SFTP

A server's SFTP address is a separate, node-level address reported by `GET /server/{id}` as
`sftp_ip`/`sftp_port` (e.g. `<node-name>.<panel-host>:2022`) — it is **not** the same as the
server's public game address (confirmed against a live panel: the game address was a
`<host>:25017`-style address, while SFTP was on a completely different host and port). `sftp_transfer`
fetches this per-server before connecting.

Run `sftp_setup` once per panel (via the MCP tool, or generate/register a key any way you like) to
get credentials in place, then `sftp_transfer` works immediately. Host keys are trusted on first use
and pinned to `~/.pufferfish-mcp/known_hosts.json` — a later mismatch refuses the connection rather
than silently accepting a different key.

`node dist/cli.js set-password <alias>` stores an account password as an SFTP fallback (never used
for panel API auth) if you'd rather not use a generated key.

## Notes

- Auth is **API-key only** — no panel passwords are used to talk to the panel API; a password is
  only ever an SFTP fallback.
- `write_file` refuses to run without `confirm: true`.
- Server references resolve by name across all configured panels when `panel` is omitted; an ambiguous match lists the candidates so you can disambiguate or prefix with `panel:`.
- The SFTP username is assumed to be `<panel-account-username>.<uuid_short>`, matching Pterodactyl's
  convention — this is **not confirmed** against a real Coral panel and may need adjusting in
  `src/sftp.ts` (`connectClient`) once tested.
