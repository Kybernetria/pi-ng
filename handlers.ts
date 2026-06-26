type ProtocolHandler = (input: unknown) => unknown | Promise<unknown>;

import { createSignalRestClient, type SignalRestClient } from "./signal-rest-client.ts";
import { getSharedRoutingState, type RoutingState } from "./routing-state.ts";

export interface CreatePiNgHandlersOptions {
  signalClient?: SignalRestClient;
  routingState?: RoutingState;
}

export function createPiNgHandlers(options: CreatePiNgHandlersOptions = {}): Record<string, ProtocolHandler> {
  const client = options.signalClient ?? createSignalRestClient();
  const routingState = options.routingState ?? getSharedRoutingState();

  return {
    send: async (input) => {
      const parsed = parseMessageInput(input);
      const metadata = isRecord(input) && isRecord(input.metadata) ? input.metadata : undefined;
      const result = await client.sendNoteToSelf(parsed.message, metadata);
      if (parsed.sessionId) routingState.setPendingRoute({ sessionId: parsed.sessionId, reason: "signal_send" });
      return {
        sent: true,
        recipient: client.account,
        ...(result.timestamp ? { timestamp: result.timestamp } : {}),
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      };
    },
  };
}

function parseMessageInput(input: unknown): { message: string; sessionId?: string } {
  if (!isRecord(input) || typeof input.message !== "string" || !input.message.trim()) {
    throw new Error("message must be a non-empty string.");
  }
  return {
    message: input.message.trim(),
    ...(typeof input.sessionId === "string" && input.sessionId.trim() ? { sessionId: input.sessionId.trim() } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
