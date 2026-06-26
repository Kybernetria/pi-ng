export interface SignalRestClientOptions {
  restUrl?: string;
  account?: string;
  fetchImpl?: FetchLike;
}

export interface ReceiveNoteToSelfOptions {
  timeoutSeconds?: number;
}

export interface NormalizedSignalMessage {
  id?: string;
  timestamp?: number | string;
  source: string;
  text: string;
  raw?: unknown;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<ResponseLike>;

interface ResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

const DEFAULT_REST_URL = "http://127.0.0.1:8080";
const DEFAULT_RECEIVE_TIMEOUT_SECONDS = 1;

export class SignalRestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SignalRestError";
  }
}

export class SignalRestClient {
  readonly restUrl: string;
  readonly account: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: SignalRestClientOptions = {}) {
    this.restUrl = normalizeRestUrl(options.restUrl ?? process.env.SIGNAL_REST_URL ?? DEFAULT_REST_URL);
    this.account = options.account ?? process.env.SIGNAL_ACCOUNT ?? "";
    if (!this.account.trim()) {
      throw new SignalRestError("SIGNAL_ACCOUNT is required for pi-ng Note-to-Self access.");
    }
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async validateAccount(): Promise<void> {
    // signal-cli-rest-api commonly exposes registered accounts at GET /v1/accounts.
    // Some deployments disable it; send/receive will still surface registration errors.
    const response = await this.fetchJson(`${this.restUrl}/v1/accounts`, { method: "GET" }, { allow404: true });
    if (response === undefined) return;
    const accounts = Array.isArray(response) ? response : getArrayProperty(response, "accounts");
    if (accounts && !accounts.some((item) => String(item) === this.account || getStringProperty(item, "number") === this.account)) {
      throw new SignalRestError("Configured SIGNAL_ACCOUNT is not registered in signal-cli-rest-api.");
    }
  }

  async sendNoteToSelf(message: string, metadata?: Record<string, unknown>): Promise<{ timestamp?: string }> {
    const text = message.trim();
    if (!text) throw new SignalRestError("message must be a non-empty string.");

    const body: Record<string, unknown> = {
      number: this.account,
      recipients: [this.account],
      message: text,
    };
    if (metadata && Object.keys(metadata).length > 0) body.dataMessage = { piNgMetadata: metadata };

    const json = await this.fetchJson(`${this.restUrl}/v2/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    return { timestamp: getStringProperty(json, "timestamp") ?? getStringProperty(json, "sendTimestamp") };
  }

  async receiveNoteToSelf(options: ReceiveNoteToSelfOptions = {}): Promise<NormalizedSignalMessage[]> {
    const timeoutSeconds = normalizeTimeout(options.timeoutSeconds);
    const url = buildReceiveUrl(this.restUrl, this.account, timeoutSeconds);
    const json = await this.fetchJson(url, { method: "GET" });
    return extractEnvelopes(json).flatMap((envelope) => normalizeNoteToSelfEnvelope(envelope, this.account) ?? []);
  }

  private async fetchJson(url: string, init: RequestInit, options: { allow404?: boolean } = {}): Promise<unknown | undefined> {
    let response: ResponseLike;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw new SignalRestError(`Signal REST API unavailable at ${this.restUrl}.`, { cause: error });
    }

    const text = await response.text();
    if (options.allow404 && response.status === 404) return undefined;
    if (!response.ok) {
      throw new SignalRestError(`Signal REST API returned ${response.status} ${response.statusText ?? ""}: ${truncate(text)}`.trim());
    }
    if (!text.trim()) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new SignalRestError("Signal REST API returned malformed JSON.", { cause: error });
    }
  }
}

export function createSignalRestClient(options: SignalRestClientOptions = {}): SignalRestClient {
  return new SignalRestClient(options);
}

// Current signal-cli-rest-api receive endpoint for JSON-RPC/REST mode is:
// GET /v1/receive/{number}?timeout={seconds}. Kept isolated so deployments can
// patch this in one place if upstream changes the receive route.
export function buildReceiveUrl(restUrl: string, account: string, timeoutSeconds: number): string {
  const url = new URL(`${normalizeRestUrl(restUrl)}/v1/receive/${encodeURIComponent(account)}`);
  url.searchParams.set("timeout", String(timeoutSeconds));
  return url.toString();
}

export function isNoteToSelfEnvelope(envelope: unknown, account: string): boolean {
  return normalizeNoteToSelfEnvelope(envelope, account) !== undefined;
}

export function normalizeNoteToSelfEnvelope(envelope: unknown, account: string): NormalizedSignalMessage | undefined {
  const wrappedEnvelope = unwrapSignalEnvelope(envelope);
  if (!isRecord(wrappedEnvelope)) return undefined;
  if (hasGroupInfo(wrappedEnvelope)) return undefined;

  const sync = getRecordProperty(wrappedEnvelope, "syncMessage");
  const data = getRecordProperty(envelope, "dataMessage") ?? getRecordProperty(sync, "sentMessage") ?? getRecordProperty(envelope, "sentMessage");
  if (!isRecord(data) || hasGroupInfo(data)) return undefined;

  const source = getStringProperty(wrappedEnvelope, "source") ?? getStringProperty(sync, "source") ?? account;
  if (source !== account) return undefined;

  const explicitTargets = [
    getStringProperty(wrappedEnvelope, "destination"),
    getStringProperty(data, "destination"),
    ...getStringArrayProperty(data, "recipients"),
  ].filter((item): item is string => Boolean(item));
  if (explicitTargets.length > 0 && !explicitTargets.every((item) => item === account)) return undefined;

  const text = getStringProperty(data, "message") ?? getStringProperty(wrappedEnvelope, "message") ?? "";
  if (!text.trim()) return undefined;

  return {
    id: (getStringProperty(wrappedEnvelope, "id") ?? getStringProperty(data, "id") ?? String(getUnknownProperty(wrappedEnvelope, "timestamp") ?? "")) || undefined,
    timestamp: getStringProperty(wrappedEnvelope, "timestamp") ?? getNumberProperty(wrappedEnvelope, "timestamp") ?? getStringProperty(data, "timestamp") ?? getNumberProperty(data, "timestamp"),
    source,
    text,
    raw: envelope,
  };
}

function extractEnvelopes(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const unwrapped = unwrapSignalEnvelope(json);
  if (unwrapped !== json) return [unwrapped];
  if (!isRecord(json)) return [];
  for (const key of ["envelopes", "messages", "results"] as const) {
    const value = json[key];
    if (Array.isArray(value)) return value;
  }
  return [json];
}

function unwrapSignalEnvelope(value: unknown): unknown {
  return isRecord(value) && isRecord(value.envelope) ? value.envelope : value;
}

function hasGroupInfo(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Boolean(value.groupInfo || value.groupV2 || value.groupId || getRecordProperty(value, "groupContext"));
}

function normalizeRestUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeTimeout(value: number | undefined): number {
  const parsed = Number.isFinite(value) ? Number(value) : Number(process.env.PI_NG_RECEIVE_TIMEOUT_SECONDS ?? DEFAULT_RECEIVE_TIMEOUT_SECONDS);
  return Math.max(0, Math.trunc(parsed));
}

function getArrayProperty(value: unknown, key: string): unknown[] | undefined {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : undefined;
}

function getStringArrayProperty(value: unknown, key: string): string[] {
  const array = getArrayProperty(value, key);
  return array ? array.filter((item): item is string => typeof item === "string") : [];
}

function getRecordProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  const child = isRecord(value) ? value[key] : undefined;
  return isRecord(child) ? child : undefined;
}

function getStringProperty(value: unknown, key: string): string | undefined {
  const child = getUnknownProperty(value, key);
  return typeof child === "string" ? child : undefined;
}

function getNumberProperty(value: unknown, key: string): number | undefined {
  const child = getUnknownProperty(value, key);
  return typeof child === "number" ? child : undefined;
}

function getUnknownProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncate(value: string): string {
  return value.length > 300 ? `${value.slice(0, 300)}…` : value;
}

const defaultFetch: FetchLike = async (url, init) => {
  if (typeof fetch !== "function") throw new SignalRestError("global fetch is unavailable.");
  return fetch(url, init) as Promise<ResponseLike>;
};
