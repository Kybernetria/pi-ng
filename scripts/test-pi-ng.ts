import assert from "node:assert/strict";
import { ensureProtocolFabric } from "@kyvernitria/pi-protocol-minimal";
import piNgExtension from "../extension.ts";
import { createPiNgDaemon, type AgentSessionRouter } from "../daemon.ts";
import { RoutingState } from "../routing-state.ts";
import { SignalRestClient, isNoteToSelfEnvelope } from "../signal-rest-client.ts";
import manifest from "../pi.protocol.json" with { type: "json" };

const account = "+15555550123";
const bannedInputKeys = ["recipient", "recipients", "destination", "phoneNumber", "contact"];

class MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  constructor(private readonly body: unknown, status = 200) {
    this.ok = status >= 200 && status < 300;
    this.status = status;
    this.statusText = this.ok ? "OK" : "ERR";
  }
  async text(): Promise<string> {
    return JSON.stringify(this.body);
  }
}

const fakePi = () => {
  const commands: string[] = [];
  return {
    commands,
    api: {
      registerCommand(name: string) {
        commands.push(name);
      },
      on() {},
      sendMessage() {},
      sendUserMessage() {},
    },
  };
};

const fetchRequests: Array<{ url: string; init?: RequestInit; body?: unknown }> = [];
const client = new SignalRestClient({
  account,
  restUrl: "http://127.0.0.1:8080",
  fetchImpl: async (url, init) => {
    fetchRequests.push({ url, init, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/v1/receive/")) return new MockResponse([]);
    return new MockResponse({ timestamp: "123" });
  },
});

const pi = fakePi();
process.env.PI_NG_ENABLE_DAEMON = "false";
ensureProtocolFabric().unregister("pi_ng");
piNgExtension(pi.api as never, { signalClient: client, enableDaemon: false });

const fabric = ensureProtocolFabric();
const registry = fabric.registry();
assert.ok(registry.nodes.some((node) => node.nodeId === "pi_ng"));
assert.deepEqual(registry.provides.map((item) => item.globalId).filter((id) => id.startsWith("pi_ng.")), ["pi_ng.send"]);

for (const provide of manifest.provides) {
  const inputProperties = provide.inputSchema.properties ?? {};
  for (const banned of bannedInputKeys) assert.equal(Object.hasOwn(inputProperties, banned), false, `${provide.name} exposes ${banned}`);
}

let result = await fabric.invoke({
  nodeId: "pi_ng",
  provide: "send",
  input: { message: "hello", recipient: "+19999999999", sessionId: "s1" },
});
assert.equal(result.ok, true);
assert.deepEqual(fetchRequests.at(-1)?.body, { number: account, recipients: [account], message: "hello" });
if (result.ok) assert.equal((result.output as { recipient: string }).recipient, account);

assert.equal(isNoteToSelfEnvelope({ source: account, dataMessage: { message: "self" } }, account), true);
assert.equal(isNoteToSelfEnvelope({ source: "+16666666666", dataMessage: { message: "other" } }, account), false);
assert.equal(isNoteToSelfEnvelope({ source: account, dataMessage: { message: "group", groupInfo: {} } }, account), false);
assert.equal(isNoteToSelfEnvelope({ malformed: true }, account), false);

assert.deepEqual(pi.commands, ["pi_ng.send"]);

class FakeRouter implements AgentSessionRouter {
  starts: string[] = [];
  routes: string[] = [];
  async start(message: string, sessionId: string): Promise<{ pending: boolean }> {
    this.starts.push(message);
    return { pending: true };
  }
  async route(message: string, sessionId: string): Promise<{ routed: boolean; pending: boolean }> {
    this.routes.push(`${sessionId}:${message}`);
    return { routed: true, pending: false };
  }
}

const state = new RoutingState({ routeTtlMs: 60_000 });
const router = new FakeRouter();
const daemonClient = {
  batches: [
    [{ id: "1", source: account, text: "pi-ng: start summarize this" }],
    [{ id: "2", source: account, text: "more detail" }],
    [{ id: "3", source: "+16666666666", text: "ignored non-self" }],
  ],
  async receiveNoteToSelf() {
    return this.batches.shift() ?? [];
  },
  async sendNoteToSelf() {
    return {};
  },
};

const daemon = createPiNgDaemon({ signalClient: daemonClient as never, routingState: state, agentRouter: router, commandPrefix: "pi-ng:" });
await daemon.pollOnce();
assert.deepEqual(router.starts, ["summarize this"]);
assert.ok(state.getPendingRoute());
const pendingId = state.getPendingRoute()?.sessionId ?? "";
await daemon.pollOnce();
assert.deepEqual(router.routes, [`${pendingId}:more detail`]);
assert.equal(state.getPendingRoute(), undefined);
await daemon.pollOnce();
assert.deepEqual(router.routes, [`${pendingId}:more detail`]);

fabric.unregister("pi_ng");
piNgExtension(fakePi().api as never, { signalClient: client, enableDaemon: false });
piNgExtension(fakePi().api as never, { signalClient: client, enableDaemon: false });
const duplicateCount = ensureProtocolFabric().registry().provides.filter((item) => item.globalId === "pi_ng.send").length;
assert.equal(duplicateCount, 1);

console.log("pi-ng protocol package tests passed");
