#!/usr/bin/env node
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import {
  loadConfig,
  loadFileConfig,
  saveConfig,
  configPath,
  validatePanelUrl,
  validateAlias,
  panelSource,
  type PanelConfig,
} from "./config.js";
import { getPanel, invalidatePanelCache, PanelError, type PanelClient } from "./panel.js";

const DEFAULT_PANEL_URL = "https://panel.pufferfish.host";

const USAGE = `pufferfish-mcp — Pufferfish MCP server CLI

Usage:
  pufferfish-mcp add-panel <alias> --client-key <key> [--url <panel-url>] [--default]
  pufferfish-mcp set-password <alias> [--clear]
  pufferfish-mcp doctor [alias]

Commands:
  add-panel     Register a panel from the command line (pasted client key) and save it to config.
  set-password  Store a panel's SFTP password, prompted without echo (never on the command line).
  doctor        Verify a configured panel: auth, list servers, SFTP readiness.

Panels can also be configured entirely via PUFFERFISH_<ALIAS>_URL / PUFFERFISH_<ALIAS>_KEY
environment variables in your MCP server settings — see README.md. add-panel/doctor manage the
config-file fallback (PUFFERFISH_MCP_CONFIG), which env vars take precedence over on a per-field
basis.

SFTP uses the server's own address (no separate host/port to configure) — run the sftp_setup MCP
tool (or set a password via set-password) to authenticate.

Run \`pufferfish-mcp <command> --help\` for command-specific help.
`;

const SET_PASSWORD_USAGE = `Usage: pufferfish-mcp set-password <alias>
       pufferfish-mcp set-password <alias> --clear

Stores a panel account password for a panel, used **only** as SFTP auth when no SSH key is
configured. Never used to log into the panel itself — panel access is always API-key based.

The password is read from an interactive prompt with echo disabled, so it never appears on screen,
in your shell history, or in the output of whatever launched this. There is deliberately no
--password flag: anything passed as an argument ends up in history and process listings.

Prefer an SSH key where possible (the sftp_setup MCP tool): a key only unlocks SFTP, whereas an
account password also unlocks the panel account itself.

Options:
  --clear   Remove the stored password for this panel.

Example:
  pufferfish-mcp set-password prod
`;

const ADD_PANEL_USAGE = `Usage: pufferfish-mcp add-panel <alias> --client-key <key> [options]

Registers a panel and stores a client API key for it.

Required:
  --client-key <key>    A client API key for the panel.

Optional:
  --url <url>   Panel base URL (must be https://). Defaults to ${DEFAULT_PANEL_URL}.
  --default     Make this panel the default for tools that omit "panel".

Example:
  pufferfish-mcp add-panel prod --client-key abc123... --default
`;

const DOCTOR_USAGE = `Usage: pufferfish-mcp doctor [alias]

Checks a configured panel (or every configured panel, if alias is omitted):
  - authenticates against the client API
  - lists servers visible to the key

Exits with status 1 if any panel fails authentication.
`;

function fail(message: string): never {
  throw new PanelError(message);
}

function describeError(err: unknown): string {
  return err instanceof PanelError ? err.message : err instanceof Error ? err.message : String(err);
}

function normalizePanelUrl(input: string): string {
  const result = validatePanelUrl(input);
  if (!result.ok) {
    return fail(`--url ${result.error}`);
  }
  return result.url;
}

/**
 * Reads a secret from the terminal without echoing it, so it never reaches the screen, the shell's
 * history, or a scrollback buffer — the whole reason this exists instead of a --password flag.
 */
function promptSecret(label: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) {
    return Promise.reject(
      new PanelError(
        "set-password needs an interactive terminal to read the password without echoing it. Run it " +
          "directly in a shell rather than through a pipe or a tool that captures output."
      )
    );
  }

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      if (err) reject(err);
      else resolve(value);
    };

    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        const code = char.charCodeAt(0);
        // Ctrl-C / Ctrl-D — an explicit cancel, not an empty password.
        if (code === 3 || code === 4) {
          return finish(new PanelError("Cancelled — nothing was written."));
        }
        if (code === 127 || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    stdin.on("data", onData);
  });
}

async function cmdSetPassword(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      clear: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(SET_PASSWORD_USAGE);
    return;
  }

  const aliasArg = positionals[0];
  if (!aliasArg) {
    fail("set-password requires a panel alias, e.g. `pufferfish-mcp set-password prod`");
  }
  const aliasResult = validateAlias(aliasArg);
  if (!aliasResult.ok) {
    fail(aliasResult.error);
  }
  const alias = aliasResult.alias;

  // The file layer, not the env-overlaid view — saving the merged config would copy any
  // env-var-only secrets from other panels onto disk as a side effect.
  const cfg = loadFileConfig();
  const panel = cfg.panels[alias];
  if (!panel) {
    fail(
      `No panel named "${alias}" in ${configPath()} — run \`pufferfish-mcp add-panel ${alias} --client-key ...\` first.`
    );
  }

  if (values.clear) {
    if (panel.password === undefined) {
      console.log(`"${alias}" had no stored password — nothing to clear.`);
      return;
    }
    delete panel.password;
    saveConfig(cfg);
    invalidatePanelCache();
    console.log(`Removed the stored SFTP password for "${alias}".`);
    return;
  }

  const password = await promptSecret(`SFTP password for "${alias}" (not shown): `);
  if (!password) {
    fail("No password entered — nothing was written. Use --clear to remove a stored password.");
  }

  panel.password = password;
  saveConfig(cfg);
  invalidatePanelCache();

  console.log(`Stored an SFTP password for "${alias}" in ${configPath()} (owner-only permissions).`);
  console.log(`Run \`pufferfish-mcp doctor ${alias}\` to confirm SFTP now reports an auth method.`);
}

interface DoctorServer {
  name: string;
}

async function countServers(panel: PanelClient): Promise<number> {
  const list = await panel.api<{ servers: Array<{ name: string }> }>("GET", "/servers");
  return list.servers.length;
}

async function cmdAddPanel(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      "client-key": { type: "string" },
      default: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(ADD_PANEL_USAGE);
    return;
  }

  const aliasArg = positionals[0];
  if (!aliasArg) {
    fail("add-panel requires an alias, e.g. `pufferfish-mcp add-panel prod --url https://panel.example.com --client-key ...`");
  }
  const aliasResult = validateAlias(aliasArg);
  if (!aliasResult.ok) {
    fail(aliasResult.error);
  }
  const alias = aliasResult.alias;
  const url = normalizePanelUrl(values.url ?? DEFAULT_PANEL_URL);

  if (!values["client-key"]) {
    fail(`add-panel requires --client-key <key>. Re-run: pufferfish-mcp add-panel ${alias} --client-key ...`);
  }

  const cfg = loadConfig();
  const merged: PanelConfig = { ...(cfg.panels[alias] ?? {}), url, client_key: values["client-key"] };

  cfg.panels[alias] = merged;
  if (values.default) cfg.default_panel = alias;

  saveConfig(cfg);
  invalidatePanelCache();

  console.log(`Saved panel "${alias}" -> ${url} (${configPath()})`);

  let count: number;
  try {
    count = await countServers(getPanel(alias));
  } catch (err) {
    throw new PanelError(`Panel "${alias}" config was saved, but verification failed: ${describeError(err)}`);
  }
  console.log(`Verified: client key works — ${count} server(s) visible on "${alias}".`);
  if (values.default) {
    console.log(`"${alias}" is now the default panel.`);
  }
}

async function doctorPanel(alias: string): Promise<boolean> {
  let panel: PanelClient;
  try {
    panel = getPanel(alias);
  } catch (err) {
    console.log(`  ✖ config: ${describeError(err)}`);
    return true;
  }
  console.log(`  panel url: ${panel.baseUrl || "(not set)"}`);
  const source = panelSource(alias);
  const sourceLabel =
    source === "both" ? "environment variable(s) + config file (env wins per-field)" :
    source === "env" ? "environment variable(s)" :
    source === "file" ? "config file" :
    "(unknown)";
  console.log(`  source: ${sourceLabel}`);

  let authOk = false;
  let servers: DoctorServer[] = [];
  try {
    const list = await panel.api<{ servers: Array<{ name: string }> }>("GET", "/servers");
    servers = list.servers.map((s) => ({ name: s.name }));
    authOk = true;
    const names = servers.length > 0 ? ` — ${servers.map((s) => s.name).join(", ")}` : "";
    console.log(`  ✔ servers: ${servers.length} visible${names}`);
  } catch (err) {
    console.log(`  ✖ servers: ${describeError(err)}`);
  }

  const panelCfg = panel.cfg;
  if (panelCfg.ssh_key && existsSync(panelCfg.ssh_key)) {
    console.log(`  ✔ sftp: ssh key present (${panelCfg.ssh_key})`);
  } else if (panelCfg.password) {
    console.log("  ✔ sftp: password available for fallback auth");
  } else {
    console.log("  ✖ sftp: no ssh key or password configured — run the sftp_setup MCP tool, or `pufferfish-mcp set-password`.");
  }

  return !authOk;
}

async function cmdDoctor(args: string[]): Promise<void> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" } },
  });

  if (values.help) {
    console.log(DOCTOR_USAGE);
    return;
  }

  const aliasArg = positionals[0];
  const cfg = loadConfig();
  const aliases = aliasArg ? [aliasArg] : Object.keys(cfg.panels);

  if (aliases.length === 0) {
    fail(
      "No panels configured yet — set PUFFERFISH_<ALIAS>_URL / PUFFERFISH_<ALIAS>_KEY environment variables in " +
        "your MCP server settings (see README.md), or run `pufferfish-mcp add-panel` to use the config-file fallback."
    );
  }

  let anyFailed = false;
  for (const alias of aliases) {
    console.log(`\n=== ${alias} ===`);
    const failed = await doctorPanel(alias);
    if (failed) anyFailed = true;
  }

  if (anyFailed) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case "add-panel":
      await cmdAddPanel(rest);
      return;
    case "set-password":
      await cmdSetPassword(rest);
      return;
    case "doctor":
      await cmdDoctor(rest);
      return;
    default:
      console.error(USAGE);
      process.exitCode = 1;
      return;
  }
}

main().catch((err) => {
  if (err instanceof PanelError) {
    console.error(err.message);
  } else {
    console.error("Fatal error:", err);
  }
  process.exitCode = 1;
});
