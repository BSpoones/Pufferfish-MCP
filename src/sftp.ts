import { readFile, writeFile, mkdir as fsMkdir, stat as fsStat, chmod as fsChmod } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import * as path from "node:path";
import Client from "ssh2-sftp-client";
// ssh2 is CommonJS — named ESM imports of `utils` fail at runtime (cjs-module-lexer
// can't statically detect it), so default-import and destructure instead.
import ssh2 from "ssh2";
import type { ConnectConfig } from "ssh2";
const ssh2Utils = ssh2.utils;
import { PanelError, getPanel, invalidatePanelCache, type PanelClient } from "./panel.js";
import { listAllServers, type ListedServer, type ServerRef } from "./resolve.js";
import { loadConfig, loadFileConfig, saveConfig, validateAlias, restrictFileAcl } from "./config.js";

const posixPath = path.posix;

// GET /account username is cached per panel alias — SFTP username is `${username}.${uuid_short}`.
const usernameCache = new Map<string, string>();

async function getPanelUsername(panel: PanelClient): Promise<string> {
  const cached = usernameCache.get(panel.alias);
  if (cached) return cached;
  const resp = await panel.api<{ username?: string }>("GET", "/account");
  const username = resp.username;
  if (!username) {
    throw new PanelError(
      `Could not determine account username for panel "${panel.alias}" from GET /account.`
    );
  }
  usernameCache.set(panel.alias, username);
  return username;
}

/** Expands a leading "~" (with optional "/" or "\\") to the user's home directory. Exported for unit testing. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

async function buildAuth(panel: PanelClient): Promise<Pick<ConnectConfig, "privateKey" | "password">> {
  const cfg = panel.cfg;
  if (cfg.ssh_key) {
    const keyPath = expandHome(cfg.ssh_key);
    try {
      const privateKey = await readFile(keyPath);
      return { privateKey };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new PanelError(
        `Could not read SSH private key at "${keyPath}" for panel "${panel.alias}": ${message}. Run sftp_setup(panel: "${panel.alias}", mode: "key") to regenerate it.`
      );
    }
  }
  if (cfg.password) {
    return { password: cfg.password };
  }
  throw new PanelError(
    `No SFTP credentials configured for panel "${panel.alias}" — run sftp_setup(panel: "${panel.alias}", mode: "key") to generate and register an SSH key, or add a "password" field to this panel's config entry.`
  );
}

// ---------------------------------------------------------------------------
// SFTP host key verification (trust-on-first-use)
// ---------------------------------------------------------------------------

/** Resolves the known-hosts file location: ~/.pufferfish-mcp/known_hosts.json. Exported for unit testing. */
export function knownHostsPath(): string {
  return path.join(homedir(), ".pufferfish-mcp", "known_hosts.json");
}

/** SHA-256/base64 fingerprint of a raw SSH host public key blob. Exported for unit testing. */
export function hostKeyFingerprint(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64");
}

/** Builds the known_hosts.json lookup key for a host:port pair. Exported for unit testing. */
export function hostEntryKey(host: string, port: number): string {
  return `${host}:${port}`;
}

export type HostKeyCheck = { status: "new" } | { status: "match" } | { status: "mismatch"; stored: string };

/**
 * Pure comparison: given the previously stored fingerprint (if any) for a host:port and the
 * fingerprint just computed from the presented key, decides whether this is a first-ever
 * connection ("new"), a known-good host ("match"), or a changed host key ("mismatch").
 * Exported for unit testing.
 */
export function compareHostKey(stored: string | undefined, fingerprint: string): HostKeyCheck {
  if (stored === undefined) return { status: "new" };
  if (stored === fingerprint) return { status: "match" };
  return { status: "mismatch", stored };
}

/** Parses a known_hosts.json file's raw text into a host:port -> fingerprint map. Exported for unit testing. */
export function parseKnownHosts(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        if (typeof value === "string") out[key] = value;
      }
      return out;
    }
  } catch {
    // corrupt/unreadable known_hosts — treat as empty rather than crashing SFTP
  }
  return {};
}

function loadKnownHosts(): Record<string, string> {
  const p = knownHostsPath();
  if (!existsSync(p)) return {};
  try {
    return parseKnownHosts(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function saveKnownHosts(map: Record<string, string>): void {
  const p = knownHostsPath();
  mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(map, null, 2), { encoding: "utf-8", mode: 0o600 });
  restrictFileAcl(p);
}

interface HostVerifyOutcome {
  accepted: boolean;
  status: "new" | "match" | "mismatch";
  fingerprint: string;
  stored?: string;
}

/** Trust-on-first-use host key verification against ~/.pufferfish-mcp/known_hosts.json. Never throws. */
function verifyHostKeyTofu(host: string, port: number, key: Buffer): HostVerifyOutcome {
  const fingerprint = hostKeyFingerprint(key);
  const known = loadKnownHosts();
  const entryKey = hostEntryKey(host, port);
  const check = compareHostKey(known[entryKey], fingerprint);

  if (check.status === "mismatch") {
    return { accepted: false, status: "mismatch", fingerprint, stored: check.stored };
  }

  if (check.status === "new") {
    known[entryKey] = fingerprint;
    try {
      saveKnownHosts(known);
    } catch {
      // best-effort — a failure to persist shouldn't block this (still-legitimate) first connection
    }
  }
  return { accepted: true, status: check.status, fingerprint };
}

function mapConnectError(err: unknown, ref: ServerRef, host: string, port: number): PanelError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("econnrefused") || lower.includes("etimedout") || lower.includes("ehostunreach") || lower.includes("enotfound")) {
    return new PanelError(
      `Could not reach the SFTP server for "${ref.name}" at ${host}:${port} (${message}).`
    );
  }
  if (lower.includes("authentication") || lower.includes("all configured authentication methods failed")) {
    return new PanelError(
      `SFTP authentication failed for "${ref.name}" (${message}). Run sftp_setup(panel: "${ref.panel.alias}") to (re)register an SSH key, or verify the configured password is correct.`
    );
  }
  return new PanelError(`SFTP connection to "${ref.name}" failed: ${message}`);
}

interface SftpDetails {
  ip: string;
  port: number;
}

// GET /server/{id}'s sftp_ip/sftp_port is a separate node-level SFTP address (e.g. port 2022) —
// NOT the same as the server's public game address, despite that being a reasonable-looking
// shortcut. Confirmed by hand against a live panel: a server's game address was on one host and
// port (e.g. nNNN.<panel-host>:25017) while its actual SFTP address was a completely different
// host and port (e.g. <node-name>.<panel-host>:2022).
async function getSftpDetails(ref: ServerRef): Promise<SftpDetails> {
  const details = await ref.panel.api<{ sftp_ip?: string; sftp_port?: number }>(
    "GET",
    `/server/${ref.identifier}`
  );
  if (!details.sftp_ip || details.sftp_port === undefined) {
    throw new PanelError(`Panel did not report an sftp_ip/sftp_port for server "${ref.name}".`);
  }
  return { ip: details.sftp_ip, port: details.sftp_port };
}

async function connectClient(ref: ServerRef): Promise<Client> {
  const [{ ip: host, port }, username, auth] = await Promise.all([
    getSftpDetails(ref),
    getPanelUsername(ref.panel),
    buildAuth(ref.panel),
  ]);

  const client = new Client(`sftp-${ref.panel.alias}-${ref.identifier}`);
  let hostKeyOutcome: HostVerifyOutcome | undefined;
  const config: ConnectConfig = {
    host,
    port,
    username: `${username}.${ref.uuid_short}`,
    readyTimeout: 20_000,
    hostVerifier: (key: Buffer): boolean => {
      hostKeyOutcome = verifyHostKeyTofu(host, port, key);
      return hostKeyOutcome.accepted;
    },
    ...auth,
  };

  try {
    await client.connect(config);
  } catch (err) {
    if (hostKeyOutcome && !hostKeyOutcome.accepted) {
      throw new PanelError(
        `SFTP host key verification FAILED for ${host}:${port} — the key presented does not match the one stored in ` +
          `~/.pufferfish-mcp/known_hosts.json, so the connection was refused. This can happen if the node was ` +
          `legitimately reinstalled, but it can also indicate a machine-in-the-middle. If you are certain the change ` +
          `is expected, remove the "${host}:${port}" entry from ~/.pufferfish-mcp/known_hosts.json and try again.`
      );
    }
    throw mapConnectError(err, ref, host, port);
  }
  return client;
}

/** Exported for unit testing; also used internally to normalize backslash-style input into POSIX remote paths. */
export function normalizeRemotePath(p: string): string {
  const normalized = p.replace(/\\/g, "/").trim();
  return normalized.length > 0 ? normalized : "/";
}

/** Exported for unit testing; formats a byte count as a human-readable size string. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${text} ${units[unitIdx]}`;
}

async function ensureRemoteParentDir(client: Client, remoteFilePath: string): Promise<void> {
  const parent = posixPath.dirname(remoteFilePath);
  if (parent && parent !== ".") {
    await client.mkdir(parent, true);
  }
}

interface TransferEvent {
  source: string;
  destination: string;
}

async function sumLocalFileSizes(paths: string[]): Promise<number> {
  let bytes = 0;
  for (const p of paths) {
    try {
      bytes += (await fsStat(p)).size;
    } catch {
      // best-effort — ignore files we can't stat after the fact
    }
  }
  return bytes;
}

async function doUpload(client: Client, ref: ServerRef, localPath: string, remote: string, start: number): Promise<string> {
  let localInfo;
  try {
    localInfo = await fsStat(localPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PanelError(`Local path "${localPath}" not found or not accessible: ${message}`);
  }

  if (localInfo.isDirectory()) {
    await client.mkdir(remote, true);
    const uploaded: string[] = [];
    const onUpload = (info: TransferEvent) => uploaded.push(info.source);
    client.on("upload", onUpload);
    try {
      await client.uploadDir(localPath, remote);
    } finally {
      client.removeListener("upload", onUpload);
    }
    const bytes = await sumLocalFileSizes(uploaded);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return `Uploaded ${uploaded.length} file(s) (${formatBytes(bytes)}) from ${localPath} to ${ref.name}:${remote} in ${elapsed}s`;
  }

  await ensureRemoteParentDir(client, remote);
  await client.fastPut(localPath, remote);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  return `Uploaded 1 file (${formatBytes(localInfo.size)}) from ${localPath} to ${ref.name}:${remote} in ${elapsed}s`;
}

async function doDownload(client: Client, ref: ServerRef, localPath: string, remote: string, start: number): Promise<string> {
  const existsType = await client.exists(remote);
  if (!existsType) {
    throw new PanelError(`Remote path "${remote}" not found on server "${ref.name}".`);
  }

  let isDirectory = existsType === "d";
  if (existsType === "l") {
    const st = await client.stat(remote);
    isDirectory = st.isDirectory;
  }

  if (isDirectory) {
    await fsMkdir(localPath, { recursive: true });
    const downloaded: string[] = [];
    const onDownload = (info: TransferEvent) => downloaded.push(info.destination);
    client.on("download", onDownload);
    try {
      await client.downloadDir(remote, localPath);
    } finally {
      client.removeListener("download", onDownload);
    }
    const bytes = await sumLocalFileSizes(downloaded);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    return `Downloaded ${downloaded.length} file(s) (${formatBytes(bytes)}) from ${ref.name}:${remote} to ${localPath} in ${elapsed}s`;
  }

  await fsMkdir(path.dirname(localPath), { recursive: true });
  await client.fastGet(remote, localPath);
  const st = await fsStat(localPath);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  return `Downloaded 1 file (${formatBytes(st.size)}) from ${ref.name}:${remote} to ${localPath} in ${elapsed}s`;
}

/**
 * Transfers a file or directory (recursively) between the local filesystem and a server's SFTP
 * endpoint (the server's own public address). Always closes the SFTP connection, even on error.
 */
export async function sftpTransfer(
  ref: ServerRef,
  direction: "upload" | "download",
  localPath: string,
  remotePath: string
): Promise<string> {
  const remote = normalizeRemotePath(remotePath);
  const start = Date.now();
  const client = await connectClient(ref);
  try {
    if (direction === "upload") {
      return await doUpload(client, ref, localPath, remote, start);
    }
    return await doDownload(client, ref, localPath, remote, start);
  } finally {
    await client.end().catch(() => {});
  }
}

function toServerRef(panel: PanelClient, entry: ListedServer): ServerRef {
  return {
    panel,
    identifier: entry.uuid,
    uuid_short: entry.uuid_short,
    name: entry.name,
    ip: entry.ip,
    port: entry.port,
  };
}

/** Best-effort restriction of the private key file to the current user; never throws. */
async function restrictKeyFilePermissions(keyPath: string, lines: string[]): Promise<void> {
  try {
    await fsChmod(keyPath, 0o600);
  } catch {
    // best-effort — many filesystems (e.g. some Windows setups) don't honor POSIX chmod bits
  }
  const winUser = process.env.USERNAME;
  if (process.platform === "win32" && winUser) {
    try {
      execFileSync("icacls", [keyPath, "/inheritance:r", "/grant:r", `${winUser}:F`], { stdio: "ignore" });
      lines.push("Restricted the private key file to the current Windows user via icacls.");
    } catch {
      lines.push(
        "Note: could not restrict the private key file's permissions via icacls (non-fatal) — ensure it isn't readable by other local users."
      );
    }
  }
}

async function testConnect(alias: string, lines: string[], label: string): Promise<void> {
  const servers = await listAllServers(alias);
  if (servers.length === 0) {
    lines.push("No servers found on this panel — skipping connection test.");
    return;
  }
  const ref = toServerRef(getPanel(alias), servers[0]!);
  try {
    const client = await connectClient(ref);
    await client.end().catch(() => {});
    lines.push(`Verified: connected via SFTP to "${ref.name}" (${ref.identifier}) using ${label}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(`Connection test FAILED: ${message}`);
  }
}

async function setupPassword(alias: string): Promise<string> {
  const panel = getPanel(alias);
  const lines: string[] = [];

  if (!panel.cfg.password) {
    throw new PanelError(
      `Panel "${alias}" has no "password" configured. Add a "password" field to its config entry (%USERPROFILE%\\.pufferfish-mcp\\config.json), or run sftp_setup with mode: "key" instead.`
    );
  }
  lines.push(`Password auth is configured for panel "${alias}".`);
  await testConnect(alias, lines, "password auth");
  return lines.join("\n");
}

async function setupKey(alias: string): Promise<string> {
  // Validate BEFORE building any filesystem path from the alias — an alias containing "/" or
  // ".." could otherwise escape ~/.pufferfish-mcp into an arbitrary location.
  const aliasResult = validateAlias(alias);
  if (!aliasResult.ok) {
    throw new PanelError(aliasResult.error);
  }

  const panel = getPanel(alias);
  const lines: string[] = [];

  const keyDir = path.join(homedir(), ".pufferfish-mcp");
  const keyPath = path.join(keyDir, `id_ed25519_${aliasResult.alias}`);
  await fsMkdir(keyDir, { recursive: true });

  let publicKey: string;
  if (existsSync(keyPath)) {
    const parsed = ssh2Utils.parseKey(await readFile(keyPath));
    if (parsed instanceof Error) {
      throw new PanelError(`Existing key at ${keyPath} could not be parsed (${parsed.message}). Delete it to generate a new one.`);
    }
    publicKey = `${parsed.type} ${parsed.getPublicSSH().toString("base64")} claude-mcp`;
    lines.push(`Reusing the existing private key at ${keyPath}.`);

    if (panel.cfg.ssh_key && path.resolve(expandHome(panel.cfg.ssh_key)) === path.resolve(keyPath)) {
      const before = lines.length;
      await testConnect(alias, lines, "the existing key");
      if (lines[before]?.startsWith("Verified")) {
        lines.push("Key is already registered and working — nothing registered with the panel.");
        return lines.join("\n");
      }
    }
  } else {
    const { private: privateKey, public: publicKeyRaw } = ssh2Utils.generateKeyPairSync("ed25519", {
      comment: "claude-mcp",
    });
    await writeFile(keyPath, privateKey, { mode: 0o600 });
    await restrictKeyFilePermissions(keyPath, lines);
    lines.push(`Generated an ed25519 keypair; private key saved to ${keyPath}.`);
    publicKey = publicKeyRaw.trim();
  }

  let registered = false;
  try {
    await panel.api("POST", "/account/ssh-keys", { name: "claude-mcp", public_key: publicKey });
    registered = true;
    lines.push("Registered the public key with your panel account via POST /account/ssh-keys.");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lines.push(
      `Could not register the public key automatically (${message}). Add it manually via your panel account's ` +
        `SSH keys page, name "claude-mcp", with this public key:\n${publicKey}\n` +
        `Alternatively, run sftp_setup(mode: "password") if a password is configured.`
    );
  }

  // Write the generated key path back to the FILE-backed config layer only (never loadConfig(),
  // which is the merged env+file view) — otherwise an alias whose url/client_key came from env
  // vars would have those secrets duplicated onto disk just to persist this one ssh_key field.
  const fileCfg = loadFileConfig();
  const existingFileEntry = fileCfg.panels[alias];
  fileCfg.panels[alias] = { ...(existingFileEntry ?? { url: panel.baseUrl }), ssh_key: keyPath };
  saveConfig(fileCfg);
  invalidatePanelCache();
  lines.push(`Saved ssh_key path into the config file entry for panel "${alias}".`);

  if (!registered) {
    lines.push("Skipping SFTP connection test since the key was not registered with the panel.");
    return lines.join("\n");
  }

  await testConnect(alias, lines, "the newly registered key");
  return lines.join("\n");
}

/**
 * One-time SFTP setup for a panel. In "key" mode, generates a local ed25519 keypair, registers
 * the public key with the panel account, and stores the private key path in config. In "password"
 * mode, verifies that the panel account password already in config works for SFTP.
 * Always returns a multi-line, human-readable summary (never throws for expected failure modes
 * such as a rejected key-registration request — those are reported in the summary instead).
 */
export async function sftpSetup(alias: string, mode: "key" | "password"): Promise<string> {
  // Validate the alias exists before doing any work.
  getPanel(alias);
  if (mode === "password") {
    return setupPassword(alias);
  }
  return setupKey(alias);
}
