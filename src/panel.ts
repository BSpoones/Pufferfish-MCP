import { statSync } from "node:fs";
import { loadConfig, configPath, type PanelConfig } from "./config.js";

export class PanelError extends Error {
  status?: number;
  detail?: string;

  constructor(message: string, status?: number, detail?: string) {
    super(message);
    this.name = "PanelError";
    this.status = status;
    this.detail = detail;
  }
}

interface ApiOptions {
  raw?: boolean;
  query?: Record<string, string>;
}

function buildUrl(base: string, path: string, query?: Record<string, string>): string {
  const url = new URL(base + path);
  if (query) {
    const params = new URLSearchParams(query);
    for (const [key, value] of params) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PanelClient {
  public readonly alias: string;
  public readonly cfg: PanelConfig;

  constructor(alias: string, cfg: PanelConfig) {
    this.alias = alias;
    this.cfg = cfg;
  }

  get baseUrl(): string {
    return this.cfg.url;
  }

  async api<T = any>(method: string, path: string, body?: unknown, opts?: ApiOptions): Promise<T> {
    const MAX_RETRIES = 3;
    const DEFAULT_RETRY_SECONDS = 2;
    if (!this.cfg.client_key) {
      throw new PanelError(
        `No client_key configured for panel "${this.alias}" — run: pufferfish-mcp add-panel ${this.alias} --url ${this.cfg.url} --client-key ...`
      );
    }

    const raw = opts?.raw ?? false;
    const url = buildUrl(`${this.baseUrl}/api/v2/client`, path, opts?.query);

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.cfg.client_key}`,
    };

    let requestBody: BodyInit | undefined;
    if (body !== undefined) {
      if (raw) {
        headers["Content-Type"] = "text/plain";
        requestBody = typeof body === "string" ? body : String(body);
      } else {
        headers["Content-Type"] = "application/json";
        requestBody = JSON.stringify(body);
      }
    }

    let attempt = 0;
    for (;;) {
      const response = await fetch(url, { method, headers, body: requestBody });

      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new PanelError(`Rate limited by panel "${this.alias}" after ${MAX_RETRIES} retries`, 429);
        }
        const retryAfterHeader = response.headers.get("Retry-After");
        const retrySeconds = retryAfterHeader ? Number(retryAfterHeader) : DEFAULT_RETRY_SECONDS;
        await sleep((Number.isFinite(retrySeconds) ? retrySeconds : DEFAULT_RETRY_SECONDS) * 1000);
        attempt++;
        continue;
      }

      if (response.status === 204) {
        return undefined as T;
      }

      if (!response.ok) {
        await this.throwForError(response);
      }

      if (raw) {
        return (await response.text()) as unknown as T;
      }

      const text = await response.text();
      if (!text) {
        return undefined as T;
      }
      return JSON.parse(text) as T;
    }
  }

  private async throwForError(response: Response): Promise<never> {
    const text = await response.text().catch(() => "");
    let detail: string | undefined;
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string; detail?: string };
        detail = parsed.detail ?? parsed.message ?? parsed.error;
      } catch {
        // Coral can answer a bad request/404 with a plain-text body (e.g. "404 page not found")
        // rather than JSON — fall back to the raw text as the detail.
        detail = text;
      }
    }
    const MAX_DETAIL_LENGTH = 1000;
    if (detail && detail.length > MAX_DETAIL_LENGTH) {
      detail = `${detail.slice(0, MAX_DETAIL_LENGTH)}…`;
    }
    const message = detail
      ? `Panel "${this.alias}" returned ${response.status}: ${detail}`
      : `Panel "${this.alias}" returned ${response.status} ${response.statusText}`;
    throw new PanelError(message, response.status, detail);
  }
}

interface ConfigFileStat {
  mtimeMs: number;
  size: number;
}

interface PanelCache {
  panels: Map<string, PanelClient>;
  defaultPanel?: string;
  configStat: ConfigFileStat | null;
}

let panelCache: PanelCache | undefined;

// Cheaply snapshots the config file's mtime/size. Never throws — a missing or unreadable file is `null`.
function statConfigFile(): ConfigFileStat | null {
  try {
    const st = statSync(configPath());
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function configStatsEqual(a: ConfigFileStat | null, b: ConfigFileStat | null): boolean {
  if (a === null || b === null) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function buildCache(): PanelCache {
  const cfg = loadConfig();
  const panels = new Map<string, PanelClient>();
  for (const [alias, panelCfg] of Object.entries(cfg.panels)) {
    panels.set(alias, new PanelClient(alias, panelCfg));
  }
  const cache: PanelCache = { panels, configStat: statConfigFile() };
  if (cfg.default_panel !== undefined) {
    cache.defaultPanel = cfg.default_panel;
  }
  return cache;
}

/** Clears the in-memory panel cache, forcing the next getPanel/allPanels call to reload config from disk. */
export function invalidatePanelCache(): void {
  panelCache = undefined;
}

/**
 * Returns the current panel cache, rebuilding it if the config file has appeared, disappeared, or
 * changed (mtime/size) since it was last built. Lets a long-lived MCP server process pick up
 * config-file changes made by another process without requiring a restart.
 */
function ensureFreshCache(): PanelCache {
  if (!panelCache) {
    panelCache = buildCache();
    return panelCache;
  }
  try {
    const currentStat = statConfigFile();
    if (!configStatsEqual(panelCache.configStat, currentStat)) {
      panelCache = buildCache();
    }
  } catch {
    // Best-effort freshness check — any failure here just means we keep using the existing cache
    // rather than letting a stat() hiccup break tool resolution.
  }
  return panelCache;
}

/**
 * Resolves a PanelClient by alias. If alias is omitted: uses default_panel, or — if exactly one
 * panel is configured — that panel. Throws PanelError listing available aliases otherwise.
 */
export function getPanel(alias?: string): PanelClient {
  const { panels, defaultPanel } = ensureFreshCache();

  if (alias !== undefined) {
    const panel = panels.get(alias);
    if (!panel) {
      const known = [...panels.keys()];
      throw new PanelError(
        known.length > 0
          ? `Unknown panel alias "${alias}". Configured panels: ${known.join(", ")}`
          : `Unknown panel alias "${alias}". No panels are configured yet — run pufferfish-mcp add-panel.`
      );
    }
    return panel;
  }

  if (defaultPanel) {
    const panel = panels.get(defaultPanel);
    if (panel) return panel;
  }

  if (panels.size === 1) {
    return [...panels.values()][0]!;
  }

  const known = [...panels.keys()];
  if (known.length === 0) {
    throw new PanelError("No panels are configured yet — run pufferfish-mcp add-panel.");
  }
  throw new PanelError(
    `No panel specified and no default_panel set. Configured panels: ${known.join(", ")}`
  );
}

/** Returns PanelClient instances for every configured panel. */
export function allPanels(): PanelClient[] {
  const { panels } = ensureFreshCache();
  return [...panels.values()];
}
