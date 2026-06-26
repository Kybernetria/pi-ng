import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Local protocol manifest type — avoids import from pi-protocol-minimal
// which isn't guaranteed to be resolvable at static-analysis time.
interface ProvideSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  execution: { type: string; handler: string };
  effects?: string[];
}
interface PiProtocolManifest {
  protocolVersion: string;
  nodeId: string;
  packageId: string;
  version: string;
  purpose: string;
  provides: ProvideSpec[];
}
import { createPiNgDaemon, type AgentSessionRouter, type PiNgDaemon } from "./daemon.ts";
import { createPiNgHandlers, type CreatePiNgHandlersOptions } from "./handlers.ts";

const _require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const manifest: PiProtocolManifest = {
  protocolVersion: "0.2.0",
  nodeId: "pi_ng",
  packageId: "pi-ng",
  version: "0.0.0-prototype",
  purpose: "Signal Note-to-Self bridge.",
  provides: [
    {
      name: "send",
      description: "Send a message to the user's Signal Note-to-Self chat.",
      inputSchema: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string" },
          sessionId: { type: "string" },
          metadata: { type: "object" },
        },
      },
      outputSchema: {
        type: "object",
        required: ["sent", "recipient"],
        properties: {
          sent: { type: "boolean" },
          recipient: { type: "string" },
          timestamp: { type: "string" },
          sessionId: { type: "string" },
        },
      },
      execution: { type: "handler", handler: "send" },
      effects: ["network", "send_message"],
    },
  ],
};

export interface PiNgExtensionOptions extends CreatePiNgHandlersOptions {
  daemon?: PiNgDaemon;
  agentRouter?: AgentSessionRouter;
  enableDaemon?: boolean;
}

function ensureProtocolMinimal(): void {
  const targetDir = join(__dirname, "node_modules", "@kyvernitria");
  const target = join(targetDir, "pi-protocol-minimal");

  // If the symlink or install already exists, we're done.
  if (existsSync(target)) return;

  const localRepo = join(homedir(), "Applications", "pi", "pi-protocol", "packages", "pi-protocol-minimal");
  if (existsSync(localRepo)) {
    mkdirSync(targetDir, { recursive: true });
    symlinkSync(localRepo, target, "dir");
    return;
  }

  const { execSync } = _require("node:child_process");
  mkdirSync(targetDir, { recursive: true });
  execSync("npm install @kyvernitria/pi-protocol-minimal@latest", { cwd: __dirname, stdio: "pipe" });
}

export default function piNgExtension(pi: ExtensionAPI, options: PiNgExtensionOptions = {}): void {
  ensureProtocolMinimal();
  const { ensureProtocolFabric, registerProtocolManifest } = _require("@kyvernitria/pi-protocol-minimal");
  const fabric = ensureProtocolFabric();

  const agentRouter = options.agentRouter ?? createPiChatAgentRouter(pi);

  fabric.unregister("pi_ng");
  registerProtocolManifest(fabric, {
    manifest,
    handlers: createPiNgHandlers(options),
  });

  registerSlashCommands(pi, fabric);

  const shouldStartDaemon = options.enableDaemon ?? parseBoolean(process.env.PI_NG_ENABLE_DAEMON, true);
  let daemon: PiNgDaemon | undefined;
  const startDaemon = (): void => {
    if (!shouldStartDaemon || daemon) return;
    daemon = options.daemon ?? createPiNgDaemon({ signalClient: options.signalClient, routingState: options.routingState, agentRouter });
    daemon.start();
  };
  const dispose = (): void => {
    daemon?.dispose();
    daemon = undefined;
    agentRouter.dispose?.();
  };
  pi.on?.("session_start", () => {
    agentRouter.setPiSessionOpen?.(true);
    startDaemon();
  });
  pi.on?.("session_shutdown", () => {
    agentRouter.setPiSessionOpen?.(false);
  });

  // Extensions can be loaded/reloaded after the active session has already
  // started. In that case no new session_start event may arrive, so start the
  // Signal polling daemon on the next tick as well. The guard inside
  // startDaemon() prevents double starts when session_start also fires.
  setTimeout(() => startDaemon(), 0);
}

function registerSlashCommands(pi: ExtensionAPI, fabric: ReturnType<typeof ensureProtocolFabric>): void {
  pi.registerCommand("pi_ng.send", {
    description: "Send a message to Signal Note-to-Self.",
    handler: async (args: string) => {
      const message = parseArgsOrPostUsage(pi, args, "/pi_ng.send <message>");
      if (!message) return;
      const output = await invokeOrThrow(fabric, "send", { message });
      postCommandResult(pi, `**pi_ng.send**\n\nSent to Signal Note-to-Self: ${String((output as { sent?: boolean }).sent)}`);
    },
  });
}

function createPiChatAgentRouter(pi: ExtensionAPI): AgentSessionRouter {
  const sessions = new Map<string, "pi" | "sdk">();
  const sdkRouter = new SdkAgentSessionRouter();
  let piSessionOpen = true;

  return {
    setPiSessionOpen(open) {
      piSessionOpen = open;
    },
    async start(message, sessionId) {
      if (piSessionOpen) {
        sessions.set(sessionId, "pi");
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        return { pending: true };
      }

      sessions.set(sessionId, "sdk");
      return sdkRouter.start(message, sessionId);
    },
    async route(message, sessionId) {
      const target = sessions.get(sessionId);
      if (!target) return { routed: false, reason: "unknown_session" };
      if (target === "sdk") return sdkRouter.route(message, sessionId);

      if (!piSessionOpen) return { routed: false, reason: "pi_session_closed" };
      pi.sendUserMessage(message, { deliverAs: "followUp" });
      return { routed: true, pending: true };
    },
    dispose() {
      sdkRouter.dispose();
    },
  };
}

class SdkAgentSessionRouter implements AgentSessionRouter {
  private session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  async start(message: string, _sessionId: string): Promise<{ response?: string; pending?: boolean }> {
    this.dispose();
    const resourceLoader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir(), noExtensions: true });
    await resourceLoader.reload();
    this.session = (await createAgentSession({ resourceLoader })).session;
    return { response: await this.promptAndCollect(message), pending: true };
  }

  async route(message: string, _sessionId: string): Promise<{ response?: string; pending?: boolean; routed: boolean; reason?: string }> {
    if (!this.session) return { routed: false, reason: "unknown_session" };
    return { response: await this.promptAndCollect(message, true), pending: true, routed: true };
  }

  dispose(): void {
    this.session?.dispose();
    this.session = undefined;
  }

  private async promptAndCollect(message: string, followUp = false): Promise<string> {
    if (!this.session) throw new Error("SDK session is not initialized.");
    let response = "";
    const unsubscribe = this.session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        response += event.assistantMessageEvent.delta;
      }
    });
    try {
      if (followUp) await this.session.followUp(message);
      else await this.session.prompt(message);
      return response.trim() || "Pi SDK session completed without a text response.";
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return `Pi SDK session failed: ${text}`;
    } finally {
      unsubscribe();
    }
  }
}

async function invokeOrThrow(fabric: ReturnType<typeof ensureProtocolFabric>, provide: string, input: unknown): Promise<unknown> {
  const result = await fabric.invoke({ nodeId: "pi_ng", provide, input });
  if (!result.ok) throw new Error(result.error.message);
  return result.output;
}

function parseArgsOrPostUsage(pi: ExtensionAPI, args: string, usage: string): string | undefined {
  const text = args.trim();
  if (text) return text;
  postCommandResult(pi, `**pi-ng usage**\n\n\`${usage}\``);
  return undefined;
}

function postCommandResult(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({
    customType: "pi-ng.command_result",
    content,
    display: true,
  });
}


function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}
