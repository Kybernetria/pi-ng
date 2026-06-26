import { createAgentSession, DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createSignalRestClient, type NormalizedSignalMessage, type SignalRestClient } from "./signal-rest-client.ts";
import { getSharedRoutingState, type RoutingState } from "./routing-state.ts";

export interface AgentSessionRouter {
  start(message: string, sessionId: string): Promise<{ response?: string; pending?: boolean }>;
  route(message: string, sessionId: string): Promise<{ response?: string; pending?: boolean; routed: boolean; reason?: string }>;
  setPiSessionOpen?(open: boolean): void;
  dispose?(): void;
}

export interface PiNgDaemonOptions {
  signalClient?: Pick<SignalRestClient, "receiveNoteToSelf" | "sendNoteToSelf">;
  routingState?: RoutingState;
  agentRouter?: AgentSessionRouter;
  intervalMs?: number;
  commandPrefix?: string;
  autoStart?: boolean;
}

export interface PiNgDaemon {
  start(): void;
  stop(): void;
  dispose(): void;
  pollOnce(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_COMMAND_PREFIX = "/pi";

export function createPiNgDaemon(options: PiNgDaemonOptions = {}): PiNgDaemon {
  const client = options.signalClient ?? createSignalRestClient();
  const routingState = options.routingState ?? getSharedRoutingState();
  const agentRouter = options.agentRouter ?? new SdkAgentSessionRouter();
  const intervalMs = options.intervalMs ?? Number(process.env.PI_NG_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  const commandPrefix = options.commandPrefix ?? process.env.PI_NG_COMMAND_PREFIX ?? DEFAULT_COMMAND_PREFIX;
  const commandPrefixes = [...new Set([commandPrefix, DEFAULT_COMMAND_PREFIX, "pi-ng:"])];
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const pollOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const messages = await client.receiveNoteToSelf({ timeoutSeconds: Number(process.env.PI_NG_RECEIVE_TIMEOUT_SECONDS ?? 1) });
      for (const message of messages) await processMessage(message, client, routingState, agentRouter, commandPrefixes);
    } finally {
      running = false;
    }
  };

  const daemon: PiNgDaemon = {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        pollOnce().catch(() => undefined);
      }, Math.max(500, intervalMs));
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    dispose() {
      this.stop();
      agentRouter.dispose?.();
    },
    pollOnce,
  };

  if (options.autoStart) daemon.start();
  return daemon;
}

async function processMessage(
  message: NormalizedSignalMessage,
  client: Pick<SignalRestClient, "sendNoteToSelf">,
  routingState: RoutingState,
  agentRouter: AgentSessionRouter,
  commandPrefixes: string[],
): Promise<void> {
  const seenKey = message.id ?? message.timestamp ?? `${message.source}:${hashText(message.text)}`;
  if (!routingState.markSeen(seenKey)) return;

  const command = parseCommand(message.text, commandPrefixes);
  if (command) {
    if (command.kind === "start" || command.kind === "ask" || command.kind === "prompt") {
      await startAgentSession(command.message, client, routingState, agentRouter);
    } else if (command.kind === "send") {
      await client.sendNoteToSelf(command.message);
    }
    return;
  }

  const pending = routingState.getPendingRoute();
  if (!pending) return;
  await routeReply(message.text, pending.sessionId, client, routingState, agentRouter);
}

async function startAgentSession(
  message: string,
  client: Pick<SignalRestClient, "sendNoteToSelf">,
  routingState: RoutingState,
  agentRouter: AgentSessionRouter,
): Promise<void> {
  const sessionId = createSessionId();
  const routed = await agentRouter.start(message, sessionId);
  if (routed.pending) routingState.setPendingRoute({ sessionId, reason: "agent_follow_up" });
  if (routed.response) await client.sendNoteToSelf(routed.response, { sessionId, via: "pi-ng" });
}

async function routeReply(
  message: string,
  sessionId: string,
  client: Pick<SignalRestClient, "sendNoteToSelf">,
  routingState: RoutingState,
  agentRouter: AgentSessionRouter,
): Promise<void> {
  const routed = await agentRouter.route(message, sessionId);
  if (!routed.routed) return;
  if (routed.pending) routingState.setPendingRoute({ sessionId, reason: "agent_follow_up" });
  else routingState.clearPendingRoute(sessionId);
  if (routed.response) await client.sendNoteToSelf(routed.response, { sessionId, via: "pi-ng" });
}

class SdkAgentSessionRouter implements AgentSessionRouter {
  private readonly sessions = new Map<string, Awaited<ReturnType<typeof createAgentSession>>["session"]>();

  async start(message: string, sessionId: string): Promise<{ response?: string; pending?: boolean }> {
    const existing = this.sessions.get(sessionId);
    existing?.dispose();

    const resourceLoader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir(), noExtensions: true });
    await resourceLoader.reload();
    const session = (await createAgentSession({ resourceLoader })).session;
    this.sessions.set(sessionId, session);

    return { response: await promptAndCollect(session, message), pending: true };
  }

  async route(message: string, sessionId: string): Promise<{ response?: string; routed: boolean; reason?: string; pending?: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { routed: false, reason: "unknown_session" };
    return { response: await promptAndCollect(session, message), routed: true, pending: true };
  }

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

async function promptAndCollect(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  message: string,
): Promise<string> {
  let response = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      response += event.assistantMessageEvent.delta;
    }
  });
  try {
    await session.prompt(message, { streamingBehavior: "followUp" });
    return response.trim() || "Pi SDK session completed without a text response.";
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return `Pi SDK session failed: ${text}`;
  } finally {
    unsubscribe();
  }
}

function parseCommand(text: string, prefixes: string[]): { kind: "start" | "ask" | "send" | "prompt"; message: string } | undefined {
  const prefix = prefixes.find((candidate) => hasCommandPrefix(text, candidate));
  if (!prefix) return undefined;
  const body = text.slice(prefix.length).replace(/^:/, "").trim();
  if (!body) return undefined;

  const [rawKind = "", ...rest] = body.split(/\s+/);
  const kind = rawKind.toLowerCase();
  const message = rest.join(" ").trim();
  if ((kind === "start" || kind === "ask" || kind === "send") && message) return { kind, message };

  // Convenience form for Signal Note-to-Self: `/pi summarize this repo`.
  // Treat the whole body as the prompt unless an explicit subcommand is used.
  return { kind: "prompt", message: body };
}

function hasCommandPrefix(text: string, prefix: string): boolean {
  if (!text.startsWith(prefix)) return false;
  const next = text[prefix.length];
  return next === undefined || /\s|:/.test(next) || prefix.endsWith(":");
}

function createSessionId(): string {
  return `pi_ng_${globalThis.crypto.randomUUID()}`;
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return String(hash);
}
