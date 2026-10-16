import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PanelError } from "../panel.js";
import { resolveServer } from "../resolve.js";
import { jsonBlock, ok, requireConfirm, wrap } from "../toolwrap.js";
import { compactStackTraces } from "../stacktrace.js";

/** A config, jar listing, or source file could coincidentally contain a line matching a frame pattern, so compaction stays scoped to files that are actually logs rather than running over every read. */
function looksLikeLogFile(filePath: string): boolean {
  return /\.log(\.\d+)?(\.gz)?$/i.test(filePath) || /\/(logs|crash-reports)\//i.test(filePath);
}

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
      description:
        "Read a file's contents from a server. Large files are truncated. " +
        "Java stack traces in a .log file (or under logs/crash-reports) are compacted by default - pass full: true for untouched output.",
      inputSchema: {
        server: serverArg,
        file: z.string().describe("File path to read."),
        full: z.boolean().optional().describe("Skip stack-trace compaction on a log file and return it untouched. Default false."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; file: string; full?: boolean; panel?: string }) => {
      const MAX_READ_LENGTH = 50000;
      const ref = await resolveServer(args.server, args.panel);
      const raw = await ref.panel.api<string>(
        "GET",
        `/server/${ref.identifier}/files/contents`,
        undefined,
        { query: { file: args.file }, raw: true }
      );
      const contents = !args.full && looksLikeLogFile(args.file) ? compactStackTraces(raw) : raw;
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

  server.registerTool(
    "archive",
    {
      description:
        "Compress files/folders into an archive on the server, or decompress an existing archive. " +
        "decompress_task queues the extraction as an async task, for large archives.",
      inputSchema: {
        server: serverArg,
        action: z.enum(["compress", "decompress", "decompress_task"]).describe("Which action to perform."),
        root: z.string().optional().default("/").describe("Base directory that files are relative to."),
        files: z
          .array(z.string())
          .describe("compress: paths (relative to root) to include. decompress/decompress_task: the archive filename relative to root."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; action: "compress" | "decompress" | "decompress_task"; root?: string; files: string[]; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const endpoint = args.action === "decompress_task" ? "decompress-task" : args.action;
      const result = await ref.panel.api("POST", `/server/${ref.identifier}/files/${endpoint}`, {
        root: args.root ?? "/",
        files: args.files,
      });
      return jsonBlock(result ?? { ok: true, action: args.action, root: args.root ?? "/", files: args.files });
    })
  );

  server.registerTool(
    "file_action",
    {
      description:
        "move (rename), copy or chmod files on a server. " +
        "move: {from, to} pairs relative to root. copy: location is the full path of the file to duplicate. chmod: {file, mode} pairs.",
      inputSchema: {
        server: serverArg,
        action: z.enum(["move", "copy", "chmod"]).describe("Which action to perform."),
        root: z.string().optional().default("/").describe("Base directory that move/chmod paths are relative to."),
        moves: z.array(z.object({ from: z.string(), to: z.string() })).optional().describe("move: rename pairs."),
        location: z.string().optional().describe("copy: full absolute path of the file to duplicate."),
        chmods: z.array(z.object({ file: z.string(), mode: z.string() })).optional().describe('chmod: {file, mode} pairs, e.g. mode "0755".'),
        panel: panelArg,
      },
    },
    wrap(
      async (args: {
        server: string;
        action: "move" | "copy" | "chmod";
        root?: string;
        moves?: Array<{ from: string; to: string }>;
        location?: string;
        chmods?: Array<{ file: string; mode: string }>;
        panel?: string;
      }) => {
        const ref = await resolveServer(args.server, args.panel);
        const base = `/server/${ref.identifier}/files`;
        const root = args.root ?? "/";
        if (args.action === "move") {
          if (!args.moves?.length) throw new PanelError("move requires moves: [{from, to}]");
          await ref.panel.api("PUT", `${base}/rename`, { root, files: args.moves });
          return ok(`Moved ${args.moves.length} item(s) under "${root}" on ${ref.name} (${ref.identifier}).`);
        }
        if (args.action === "copy") {
          if (!args.location) throw new PanelError("copy requires location");
          await ref.panel.api("POST", `${base}/copy`, { location: args.location });
          return ok(`Copied "${args.location}" on ${ref.name} (${ref.identifier}).`);
        }
        if (!args.chmods?.length) throw new PanelError("chmod requires chmods: [{file, mode}]");
        await ref.panel.api("POST", `${base}/chmod`, { root, files: args.chmods });
        return ok(`Changed permissions on ${args.chmods.length} item(s) under "${root}" on ${ref.name} (${ref.identifier}).`);
      }
    )
  );

  server.registerTool(
    "search_files",
    {
      description: "Search file contents on a server (grep-style).",
      inputSchema: {
        server: serverArg,
        query: z.string().describe("Text or pattern to search for."),
        path: z.string().optional().describe("Directory to search under."),
        mode: z.string().optional().describe("Search mode as accepted by the panel."),
        case_sensitive: z.boolean().optional(),
        fixed_string: z.boolean().optional().describe("Treat query as a literal string rather than a regex."),
        file_glob: z.string().optional().describe("Only search files matching this glob."),
        context_before: z.number().optional(),
        context_after: z.number().optional(),
        max_matches: z.number().optional(),
        panel: panelArg,
      },
    },
    wrap(async (args: Record<string, any>) => {
      const ref = await resolveServer(args.server, args.panel);
      const query: Record<string, string> = {};
      for (const key of ["query", "path", "mode", "case_sensitive", "fixed_string", "file_glob", "context_before", "context_after", "max_matches"]) {
        if (args[key] !== undefined) query[key] = String(args[key]);
      }
      return jsonBlock(await ref.panel.api("GET", `/server/${ref.identifier}/files/search`, undefined, { query }));
    })
  );

  server.registerTool(
    "download_file",
    {
      description: "Download a file from the server to a local path on this machine (parent directories are created). Use archive first to download a folder.",
      inputSchema: {
        server: serverArg,
        remote_path: z.string().describe("Absolute path of the file on the server."),
        local_path: z.string().describe("Local destination file path."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; remote_path: string; local_path: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const signed = await ref.panel.api<{ attributes: { url: string } }>(
        "GET",
        `/server/${ref.identifier}/files/download`,
        undefined,
        { query: { file: args.remote_path } }
      );
      const response = await fetch(signed.attributes.url);
      if (!response.ok) {
        throw new PanelError(`Signed-URL download failed with HTTP ${response.status}`, response.status);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      mkdirSync(dirname(args.local_path), { recursive: true });
      writeFileSync(args.local_path, bytes);
      return ok(`Downloaded ${args.remote_path} (${bytes.length} bytes) to ${args.local_path}.`);
    })
  );

  server.registerTool(
    "upload_file",
    {
      description:
        "Upload a local file into a directory on the server via the panel's signed upload URL (suited to files under ~95 MB; use sftp_transfer for larger ones). " +
        "Overwrites a file of the same name — requires confirm: true.",
      inputSchema: {
        server: serverArg,
        local_path: z.string().describe("Path to the local file on this machine."),
        remote_dir: z.string().optional().default("/").describe("Destination directory on the server."),
        confirm: z.boolean().optional().describe("Must be true to perform the upload."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; local_path: string; remote_dir?: string; confirm?: boolean; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      const remoteDir = args.remote_dir ?? "/";
      const name = basename(args.local_path);
      requireConfirm(args.confirm, `upload "${name}" into "${remoteDir}" on ${ref.name}`);
      const size = statSync(args.local_path).size;
      const signed = await ref.panel.api<{ attributes: { url: string } }>("GET", `/server/${ref.identifier}/files/upload`);
      const form = new FormData();
      form.append("files", new Blob([readFileSync(args.local_path)]), name);
      const response = await fetch(`${signed.attributes.url}&directory=${encodeURIComponent(remoteDir)}`, { method: "POST", body: form });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new PanelError(`Signed-URL upload failed with HTTP ${response.status}${text ? `: ${text}` : ""}`, response.status);
      }
      return ok(`Uploaded "${name}" (${size} bytes) to ${remoteDir} on ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
    })
  );
}
