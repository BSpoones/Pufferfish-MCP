import { allPanels, getPanel, PanelError, type PanelClient } from "./panel.js";

export interface ServerRef {
  panel: PanelClient;
  identifier: string;
  uuid_short: string;
  name: string;
  // The server's public address — also its SFTP address, since Pufferfish nodes are directly
  // reachable (no internal-only node hostname requiring a separate sftp_ip lookup).
  ip: string;
  port: number;
}

export interface ListedServer {
  panel: PanelClient;
  uuid: string;
  uuid_short: string;
  name: string;
  status: string;
  ip: string;
  port: number;
}

interface ServersResponse {
  servers: Array<{ uuid: string; uuid_short: string; name: string; status: string; ip: string; port: number }>;
}

async function fetchServersForPanel(panel: PanelClient): Promise<ListedServer[]> {
  const response = await panel.api<ServersResponse>("GET", "/servers");
  return (response.servers ?? []).map((s) => ({
    panel,
    uuid: s.uuid,
    uuid_short: s.uuid_short,
    name: s.name,
    status: s.status,
    ip: s.ip,
    port: s.port,
  }));
}

/** Lists servers, either for a single panel (panelAlias given) or across all configured panels. */
export async function listAllServers(panelAlias?: string): Promise<ListedServer[]> {
  const panels = panelAlias !== undefined ? [getPanel(panelAlias)] : allPanels();
  const results: ListedServer[] = [];
  for (const panel of panels) {
    results.push(...(await fetchServersForPanel(panel)));
  }
  return results;
}

function describeCandidate(entry: ListedServer): string {
  return `${entry.name} (${entry.panel.alias})`;
}

/**
 * Resolves a server reference string to a concrete ServerRef.
 *
 * Accepted forms:
 *  - "alias:ref" — explicit panel alias prefix, ref is any of the forms below
 *  - a full uuid or uuid_short (exact match)
 *  - a case-insensitive name (exact match)
 *  - a case-insensitive name substring (must be unique)
 *
 * Search order: exact uuid/uuid_short match, exact name match, unique substring match.
 */
export async function resolveServer(ref: string, panelAlias?: string): Promise<ServerRef> {
  let alias = panelAlias;
  let identifier = ref;

  const colonIdx = ref.indexOf(":");
  if (colonIdx > 0 && alias === undefined) {
    const prefix = ref.slice(0, colonIdx);
    // Only treat as "alias:ref" if the prefix actually names a configured panel.
    try {
      getPanel(prefix);
      alias = prefix;
      identifier = ref.slice(colonIdx + 1);
    } catch {
      // not a known alias — treat the whole string as the identifier
    }
  }

  const candidates = await listAllServers(alias);

  if (candidates.length === 0) {
    throw new PanelError(
      alias ? `No servers found on panel "${alias}".` : "No servers found on any configured panel."
    );
  }

  const idLower = identifier.toLowerCase();

  const idMatches = candidates.filter((c) => c.uuid === identifier || c.uuid_short === identifier);
  if (idMatches.length === 1) {
    return toServerRef(idMatches[0]!);
  }

  const exactNameMatches = candidates.filter((c) => c.name.toLowerCase() === idLower);
  if (exactNameMatches.length === 1) {
    return toServerRef(exactNameMatches[0]!);
  }
  if (exactNameMatches.length > 1) {
    throw new PanelError(
      `Multiple servers match "${ref}": ${exactNameMatches
        .map(describeCandidate)
        .join(", ")} — be more specific or prefix with "panel:"`
    );
  }

  const substringMatches = candidates.filter((c) => c.name.toLowerCase().includes(idLower));
  if (substringMatches.length === 1) {
    return toServerRef(substringMatches[0]!);
  }
  if (substringMatches.length > 1) {
    throw new PanelError(
      `Multiple servers match "${ref}": ${substringMatches
        .map(describeCandidate)
        .join(", ")} — be more specific or prefix with "panel:"`
    );
  }

  throw new PanelError(
    `No server matching "${ref}" found. Available servers: ${candidates.map(describeCandidate).join(", ")}`
  );
}

function toServerRef(entry: ListedServer): ServerRef {
  return {
    panel: entry.panel,
    // Coral's swagger documents server_id path params as the SHORT uuid, not the full one.
    identifier: entry.uuid_short,
    uuid_short: entry.uuid_short,
    name: entry.name,
    ip: entry.ip,
    port: entry.port,
  };
}
