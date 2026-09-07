import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerMetaTools } from "./tools/meta-tools.js";
import { registerServersTools } from "./tools/servers-tools.js";
import { registerPowerTools } from "./tools/power-tools.js";
import { registerFilesTools } from "./tools/files-tools.js";
import { registerBackupsTools } from "./tools/backups-tools.js";
import { registerSftpTools } from "./tools/sftp-tools.js";

// CRITICAL: never console.log in this process — stdout is the MCP JSON-RPC channel.
// Use console.error for any diagnostic output.

async function main(): Promise<void> {
  const server = new McpServer({ name: "pufferfish", version: "0.1.0" });

  registerMetaTools(server);
  registerServersTools(server);
  registerPowerTools(server);
  registerFilesTools(server);
  registerBackupsTools(server);
  registerSftpTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting pufferfish-mcp server:", err);
  process.exit(1);
});
