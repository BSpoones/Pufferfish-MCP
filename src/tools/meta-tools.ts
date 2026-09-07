import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { jsonBlock, wrap } from "../toolwrap.js";

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    "list_panels",
    {
      description:
        "List configured Coral (Pufferfish) panels: alias, base URL, whether a client key is set, and which panel is the default. Never prints the actual key value.",
      inputSchema: {},
    },
    wrap(async () => {
      const cfg = loadConfig();
      const result = Object.entries(cfg.panels).map(([alias, panel]) => ({
        alias,
        url: panel.url,
        has_client_key: Boolean(panel.client_key),
        is_default: cfg.default_panel === alias,
      }));
      return jsonBlock(result);
    })
  );
}
