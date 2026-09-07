import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PanelError } from "../panel.js";
import { resolveServer, type ServerRef } from "../resolve.js";
import { jsonBlock, ok, wrap } from "../toolwrap.js";

const panelArg = z
  .string()
  .optional()
  .describe("Panel alias to restrict/select. Omit to use the default panel or search across all configured panels.");

const serverArg = z
  .string()
  .describe('Server reference: "alias:name-or-id", a full UUID, or a unique name substring.');

async function pollForState(ref: ServerRef, targetStates: string[]): Promise<{ state: string; elapsedMs: number }> {
  const POLL_INTERVAL_MS = 3000;
  const POLL_TIMEOUT_MS = 120_000;
  const start = Date.now();
  for (;;) {
    const resp = await ref.panel.api<{ state: string }>("GET", `/server/${ref.identifier}/resources`);
    const state = resp.state;
    const elapsedMs = Date.now() - start;
    if (state && targetStates.includes(state)) {
      return { state, elapsedMs };
    }
    if (elapsedMs >= POLL_TIMEOUT_MS) {
      return { state: state ?? "unknown", elapsedMs };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export function registerPowerTools(server: McpServer): void {
  server.registerTool(
    "power",
    {
      description:
        "Send a power action (start, stop, restart, kill) to a server. With wait: true, polls resource state every 3s (up to 120s) until the server reaches the expected end state, then reports the final state and elapsed time.",
      inputSchema: {
        server: serverArg,
        action: z.enum(["start", "stop", "restart", "kill"]).describe("Power action to send."),
        wait: z.boolean().optional().default(false).describe("If true, poll until the server reaches the target state (or 120s timeout)."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; action: "start" | "stop" | "restart" | "kill"; wait?: boolean; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);
      await ref.panel.api("POST", `/server/${ref.identifier}/power`, { action: args.action });

      if (!args.wait) {
        return ok(`Sent "${args.action}" to ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
      }

      const targetStates = args.action === "start" || args.action === "restart" ? ["running"] : ["offline"];
      const { state, elapsedMs } = await pollForState(ref, targetStates);
      const reached = targetStates.includes(state);
      return jsonBlock({
        server: ref.name,
        identifier: ref.identifier,
        panel: ref.panel.alias,
        action: args.action,
        final_state: state,
        reached_target: reached,
        elapsed_seconds: Math.round(elapsedMs / 1000),
      });
    })
  );

  server.registerTool(
    "send_command",
    {
      description:
        "Send a console command to a running server. Fire-and-forget — no output capture. The server must " +
        "be running; a 502/409 response usually means it is offline.",
      inputSchema: {
        server: serverArg,
        command: z.string().describe("The console command to send, exactly as typed in-game/in-console."),
        panel: panelArg,
      },
    },
    wrap(async (args: { server: string; command: string; panel?: string }) => {
      const ref = await resolveServer(args.server, args.panel);

      try {
        await ref.panel.api("POST", `/server/${ref.identifier}/command`, { command: args.command });
      } catch (err) {
        if (err instanceof PanelError && (err.status === 502 || err.status === 409)) {
          throw new PanelError(
            `${err.message} (the server is likely offline)`,
            err.status,
            err.detail
          );
        }
        throw err;
      }

      return ok(`Sent command to ${ref.name} (${ref.identifier}) on panel ${ref.panel.alias}.`);
    })
  );
}
