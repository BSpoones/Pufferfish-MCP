import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PanelError } from "../panel.js";
import { resolveServer } from "../resolve.js";
import { jsonBlock, ok, requireConfirm, wrap } from "../toolwrap.js";

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

  server.registerTool(
    "backup_action",
    {
      description:
        "Lock, unlock, delete, restore or get a download URL for a backup. " +
        "delete and restore are destructive and require confirm: true; restore with truncate: true wipes the server's files first.",
      inputSchema: {
        server: serverArg,
        action: z.enum(["lock", "unlock", "delete", "restore", "download"]).describe("Which action to perform."),
        backup_id: z.number().describe("Numeric backup id from list_backups."),
        truncate: z.boolean().optional().describe("restore: delete all existing files before restoring. Default false."),
        confirm: z.boolean().optional().describe("Must be true for delete and restore."),
        panel: panelArg,
      },
    },
    wrap(
      async (args: {
        server: string;
        action: "lock" | "unlock" | "delete" | "restore" | "download";
        backup_id: number;
        truncate?: boolean;
        confirm?: boolean;
        panel?: string;
      }) => {
        const ref = await resolveServer(args.server, args.panel);
        const base = `/server/${ref.identifier}/backups`;
        const body = { backup_id: args.backup_id };
        const query = { backup_id: String(args.backup_id) };
        if (args.action === "download") {
          return jsonBlock(await ref.panel.api("GET", `${base}/download`, undefined, { query }));
        }
        if (args.action === "delete") {
          requireConfirm(args.confirm, `delete backup ${args.backup_id} on ${ref.name}`);
          await ref.panel.api("DELETE", `${base}/delete`, body, { query });
          return ok(`Deleted backup ${args.backup_id} on ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
        }
        if (args.action === "restore") {
          requireConfirm(args.confirm, `restore backup ${args.backup_id} on ${ref.name}${args.truncate ? " after wiping its files" : ""}`);
          await ref.panel.api("POST", `${base}/restore`, { backup_id: args.backup_id, truncate: args.truncate ?? false });
          return ok(`Restore of backup ${args.backup_id} started on ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
        }
        await ref.panel.api("POST", `${base}/${args.action}`, body);
        return ok(`${args.action === "lock" ? "Locked" : "Unlocked"} backup ${args.backup_id} on ${ref.name} (${ref.identifier}).`);
      }
    )
  );

  server.registerTool(
    "emergency_backups",
    {
      description: "List the server's emergency backups, or restore paths from one (restore requires confirm: true).",
      inputSchema: {
        server: serverArg,
        action: z.enum(["list", "restore"]).describe("Which action to perform."),
        short_id: z.string().optional().describe("restore: short_id of the emergency backup from the list."),
        restore_paths: z.array(z.string()).optional().describe("restore: paths to restore from the backup."),
        confirm: z.boolean().optional().describe("Must be true for restore."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; action: "list" | "restore"; short_id?: string; restore_paths?: string[]; confirm?: boolean; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const base = `/server/${ref.identifier}/emergency-backups`;
      if (args.action === "list") {
        return jsonBlock(await ref.panel.api("GET", base));
      }
      if (!args.short_id || !args.restore_paths?.length) {
        throw new PanelError("restore requires short_id and restore_paths");
      }
      requireConfirm(args.confirm, `restore ${args.restore_paths.join(", ")} from emergency backup ${args.short_id} on ${ref.name}`);
      await ref.panel.api("POST", `${base}/restore`, { short_id: args.short_id, restore_paths: args.restore_paths });
      return ok(`Restore from emergency backup ${args.short_id} started on ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
    })
  );
}
