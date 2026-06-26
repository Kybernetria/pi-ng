import { buildReceiveUrl, isNoteToSelfEnvelope, normalizeNoteToSelfEnvelope } from "../signal-rest-client.ts";

const restUrl = process.env.SIGNAL_REST_URL ?? "http://127.0.0.1:8080";
const account = process.env.SIGNAL_ACCOUNT;
if (!account) throw new Error("SIGNAL_ACCOUNT is required");

const seconds = Number(process.argv[2] ?? 60);
const timeout = Number(process.env.PI_NG_RECEIVE_TIMEOUT_SECONDS ?? 5);
const stopAt = Date.now() + seconds * 1000;
let totalRaw = 0;
let totalAccepted = 0;

console.log(`pi-ng debug receive: polling ${restUrl} for ${seconds}s as ${redactNumber(account)}`);
console.log("Send a Signal Note-to-Self now, for example: /pi hello from phone");

while (Date.now() < stopAt) {
  const url = buildReceiveUrl(restUrl, account, timeout);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    console.log(`[${new Date().toISOString()}] HTTP ${response.status}: ${text.slice(0, 200)}`);
    await sleep(1000);
    continue;
  }

  let payload: unknown;
  try {
    payload = text.trim() ? JSON.parse(text) : [];
  } catch {
    console.log(`[${new Date().toISOString()}] malformed JSON: ${text.slice(0, 200)}`);
    continue;
  }

  const envelopes = Array.isArray(payload) ? payload : [payload];
  totalRaw += envelopes.length;
  const accepted = envelopes.map((item) => normalizeNoteToSelfEnvelope(item, account)).filter((item) => item !== undefined);
  totalAccepted += accepted.length;

  if (envelopes.length === 0) {
    console.log(`[${new Date().toISOString()}] raw=0 accepted=0`);
    continue;
  }

  console.log(`[${new Date().toISOString()}] raw=${envelopes.length} accepted=${accepted.length}`);
  for (const [index, envelope] of envelopes.entries()) {
    console.log(`  raw[${index}] summary=${JSON.stringify(summarizeEnvelope(envelope, account))}`);
    console.log(`  raw[${index}] noteToSelf=${isNoteToSelfEnvelope(envelope, account)}`);
  }
  for (const [index, message] of accepted.entries()) {
    console.log(`  accepted[${index}] id=${message.id ?? ""} source=${redactNumber(message.source)} text=${redactText(message.text)}`);
  }
}

console.log(`done: totalRaw=${totalRaw} totalAccepted=${totalAccepted}`);

function summarizeEnvelope(value: unknown, accountValue: string): unknown {
  if (!isRecord(value)) return typeof value;
  const wrapped = getRecord(value, "envelope") ?? value;
  const data = getRecord(wrapped, "dataMessage") ?? getRecord(getRecord(wrapped, "syncMessage"), "sentMessage");
  return {
    wrapperKeys: Object.keys(value).slice(0, 20),
    envelopeKeys: Object.keys(wrapped).slice(0, 20),
    source: redactNumber(getString(wrapped, "source") ?? ""),
    timestamp: wrapped.timestamp,
    hasSyncMessage: Boolean(wrapped.syncMessage),
    hasDataMessage: Boolean(wrapped.dataMessage),
    hasGroup: Boolean(wrapped.groupInfo || wrapped.groupV2 || getRecord(wrapped, "groupContext") || data?.groupInfo || data?.groupV2),
    dataKeys: data ? Object.keys(data).slice(0, 20) : [],
    dataDestinationIsSelf: getString(data, "destination") === accountValue,
    dataRecipientsCount: Array.isArray(data?.recipients) ? data.recipients.length : undefined,
    textPreview: redactText(getString(data, "message") ?? getString(wrapped, "message") ?? ""),
  };
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function redactNumber(value: string): string {
  if (!value) return "";
  return value.length <= 6 ? "<redacted>" : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

function redactText(value: string): string {
  if (!value) return "<empty>";
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.startsWith("/pi")) return `/pi <${Math.max(0, compact.length - 3)} chars>`;
  return `<${compact.length} chars>`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
