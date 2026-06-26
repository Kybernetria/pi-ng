export interface PendingRoute {
  sessionId: string;
  createdAt: number;
  reason?: string;
  agentName?: string;
}

export interface RoutingStateOptions {
  routeTtlMs?: number;
  now?: () => number;
}

const DEFAULT_ROUTE_TTL_MS = 10 * 60 * 1000;
const MAX_SEEN = 2_000;

export class RoutingState {
  private pendingRouteValue: PendingRoute | undefined;
  private readonly seen = new Set<string>();
  private readonly now: () => number;
  readonly routeTtlMs: number;

  constructor(options: RoutingStateOptions = {}) {
    this.routeTtlMs = options.routeTtlMs ?? Number(process.env.PI_NG_ROUTE_TTL_MS ?? DEFAULT_ROUTE_TTL_MS);
    this.now = options.now ?? (() => Date.now());
  }

  setPendingRoute(route: Omit<PendingRoute, "createdAt"> & { createdAt?: number }): void {
    this.pendingRouteValue = { ...route, createdAt: route.createdAt ?? this.now() };
  }

  getPendingRoute(): PendingRoute | undefined {
    this.expirePendingRoute();
    return this.pendingRouteValue ? { ...this.pendingRouteValue } : undefined;
  }

  clearPendingRoute(sessionId?: string): void {
    if (!sessionId || this.pendingRouteValue?.sessionId === sessionId) this.pendingRouteValue = undefined;
  }

  expirePendingRoute(): boolean {
    if (!this.pendingRouteValue) return false;
    if (this.now() - this.pendingRouteValue.createdAt <= this.routeTtlMs) return false;
    this.pendingRouteValue = undefined;
    return true;
  }

  markSeen(key: string | number | undefined): boolean {
    const normalized = String(key ?? "").trim();
    if (!normalized) return false;
    if (this.seen.has(normalized)) return false;
    this.seen.add(normalized);
    if (this.seen.size > MAX_SEEN) {
      const first = this.seen.values().next().value as string | undefined;
      if (first) this.seen.delete(first);
    }
    return true;
  }

  hasSeen(key: string | number | undefined): boolean {
    const normalized = String(key ?? "").trim();
    return normalized ? this.seen.has(normalized) : false;
  }
}

let sharedRoutingState: RoutingState | undefined;

export function getSharedRoutingState(): RoutingState {
  sharedRoutingState ??= new RoutingState();
  return sharedRoutingState;
}

export function setSharedRoutingState(state: RoutingState | undefined): void {
  sharedRoutingState = state;
}
