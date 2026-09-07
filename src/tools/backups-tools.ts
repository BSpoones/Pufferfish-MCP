import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveServer } from "../resolve.js";
import { jsonBlock, wrap } from "../toolwrap.js";

const panelArg = z
  .string()
  .optional()
  .describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

const serverArg = z
  .string()
  .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.');

export function registerBackupsTools(server: McpServer): void {
  server.registerTool(
    "list_backups",
    {
      description: "List backups for a server.",
      inputSchema: {
        server: serverArg,
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const backups = await ref.panel.api("GET", `/server/${ref.identifier}/backups/list`);
      return jsonBlock(backups);
    })
  );

  server.registerTool(
    "create_backup",
    {
      description: "Create a new backup for a server.",
      inputSchema: {
        server: serverArg,
        name: z.string().optional().describe("Backup name. Omit to let the panel assign a default."),
        locked: z.boolean().optional().describe("If true, the backup is locked against automatic pruning."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; name?: string; locked?: boolean; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const body: { name?: string; locked?: boolean } = {};
      if (args.name !== undefined) body.name = args.name;
      if (args.locked !== undefined) body.locked = args.locked;
      const backup = await ref.panel.api("POST", `/server/${ref.identifier}/backups/create`, body);
      return jsonBlock(backup);
    })
  );
}
