import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allPanels, getPanel, type PanelClient } from "../panel.js";
import { resolveServer } from "../resolve.js";
import { jsonBlock, wrap } from "../toolwrap.js";

const panelArg = z
  .string()
  .optional()
  .describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

const serverArg = z
  .string()
  .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.');

interface CoralServerEntry {
  uuid: string;
  uuid_short: string;
  name: string;
  description: string;
  status: string;
  node_name: string;
  ip: string;
  ip_alias: string;
  port: number;
  cpu: number;
  memory: number;
  disk: number;
}

interface ServersResponse {
  servers: CoralServerEntry[];
}

async function fetchServersForPanel(panel: PanelClient): Promise<Array<CoralServerEntry & { panel: string }>> {
  const response = await panel.api<ServersResponse>("GET", "/servers");
  return (response.servers ?? []).map((s) => ({ ...s, panel: panel.alias }));
}

export function registerServersTools(server: McpServer): void {
  server.registerTool(
    "list_servers",
    {
      description:
        "Lists servers visible to the configured key(s). With no panel given, searches every configured panel.",
      inputSchema: {
        panel: panelArg,
      },
    },
    wrap(async (args: { panel?: string }) => {
      const panels = args.panel !== undefined ? [getPanel(args.panel)] : allPanels();
      const results: Array<CoralServerEntry & { panel: string }> = [];
      for (const panel of panels) {
        results.push(...(await fetchServersForPanel(panel)));
      }
      return jsonBlock(results);
    })
  );

  server.registerTool(
    "server_details",
    {
      description:
        "Gets full server details from the panel, including the sftp_ip/sftp_port the panel itself reports (which may differ from the server's public game address).",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const details = await ref.panel.api("GET", `/server/${ref.identifier}`);
      return jsonBlock(details);
    })
  );

  server.registerTool(
    "server_resources",
    {
      description: "Gets live resource utilization (CPU, memory, disk, network, uptime) for a server.",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const resources = await ref.panel.api("GET", `/server/${ref.identifier}/resources`);
      return jsonBlock(resources);
    })
  );
}
