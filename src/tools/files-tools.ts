import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveServer } from "../resolve.js";
import { jsonBlock, ok, requireConfirm, wrap } from "../toolwrap.js";

const panelArg = z
  .string()
  .optional()
  .describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

const serverArg = z
  .string()
  .describe('Server reference: "alias:name-or-id", an 8-char identifier, a full UUID, or a unique name substring.');

export function registerFilesTools(server: McpServer): void {
  server.registerTool(
    "list_files",
    {
      description: "List files and directories at a path on a server.",
      inputSchema: {
        server: serverArg,
        directory: z.string().optional().default("/").describe("Directory path to list."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; directory?: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const directory = args.directory ?? "/";
      const response = await ref.panel.api(
        "GET",
        `/server/${ref.identifier}/files/list`,
        undefined,
        { query: { directory } }
      );
      return jsonBlock(response);
    })
  );

  server.registerTool(
    "create_folder",
    {
      description: "Create a folder on a server.",
      inputSchema: {
        server: serverArg,
        root: z.string().optional().default("/").describe("Parent directory the new folder is created under."),
        name: z.string().describe("Name of the new folder (not a path — created directly under root)."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; root?: string; name: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      await ref.panel.api("POST", `/server/${ref.identifier}/files/create-folder`, {
        root: args.root ?? "/",
        name: args.name,
      });
      return ok(`Created folder "${args.name}" under "${args.root ?? "/"}" on ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
    })
  );

  server.registerTool(
    "delete_files",
    {
      description: "Delete one or more files/folders on a server. Destructive — requires confirm: true.",
      inputSchema: {
        server: serverArg,
        root: z.string().optional().default("/").describe("Directory the file names are relative to."),
        files: z.array(z.string()).describe("File/folder names to delete, relative to root (not full paths)."),
        confirm: z.boolean().optional().describe("Must be true to perform the delete."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; root?: string; files: string[]; confirm?: boolean; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      requireConfirm(args.confirm, `delete ${args.files.join(", ")} under "${args.root ?? "/"}" on ${ref.name}`);
      await ref.panel.api("POST", `/server/${ref.identifier}/files/delete`, {
        root: args.root ?? "/",
        files: args.files,
      });
      return ok(`Deleted ${args.files.join(", ")} under "${args.root ?? "/"}" on ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
    })
  );

  server.registerTool(
    "read_file",
    {
      description: "Read a file's contents from a server. Large files are truncated.",
      inputSchema: {
        server: serverArg,
        file: z.string().describe("File path to read."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; file: string; panel?: string }) => {
      const MAX_READ_LENGTH = 50000;
      const ref = await resolveServer(args.server, args.panel);
      const contents = await ref.panel.api<string>(
        "GET",
        `/server/${ref.identifier}/files/contents`,
        undefined,
        { query: { file: args.file }, raw: true }
      );
      if (contents.length > MAX_READ_LENGTH) {
        return ok(`${contents.slice(0, MAX_READ_LENGTH)}\n\n[truncated — file is ${contents.length} chars, showing first ${MAX_READ_LENGTH}]`);
      }
      return ok(contents);
    })
  );

  server.registerTool(
    "write_file",
    {
      description: "Overwrite a file's contents on a server. Destructive — requires confirm: true.",
      inputSchema: {
        server: serverArg,
        file: z.string().describe("File path to write."),
        contents: z.string().describe("New file contents."),
        confirm: z.boolean().optional().describe("Must be true to perform the write."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; file: string; contents: string; confirm?: boolean; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      requireConfirm(args.confirm, `overwrite "${args.file}" on ${ref.name}`);
      await ref.panel.api(
        "POST",
        `/server/${ref.identifier}/files/write`,
        args.contents,
        { query: { file: args.file }, raw: true }
      );
      return ok(`Wrote ${args.contents.length} chars to "${args.file}" on ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
    })
  );
}
