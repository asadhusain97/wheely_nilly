import { diffPortfolio } from "./portfolio-diff";
import type { BrokerageSnapshot, PortfolioDiff, RefreshPolicy } from "./types";

export interface RefreshCoordinatorDependencies {
  refreshMarket(signal: AbortSignal): Promise<void>;
  refreshBrokerage(signal: AbortSignal): Promise<BrokerageSnapshot>;
  refreshAffectedMarket(diff: PortfolioDiff, signal: AbortSignal): Promise<void>;
  readPortfolio(): BrokerageSnapshot | null;
  writePortfolio(snapshot: BrokerageSnapshot): Promise<void>;
  onError(slice: "market" | "brokerage", error: unknown): void;
  now?(): number;
  document?: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
}

export const DEFAULT_REFRESH_POLICY: RefreshPolicy = {
  marketIntervalMs: 120_000,
  brokerageIntervalMs: 1_800_000,
  refreshBrokerageOnOpen: true,
  manualBrokerageCooldownMs: 300_000,
};

export class RefreshCoordinator {
  readonly policy: RefreshPolicy;
  readonly dependencies: RefreshCoordinatorDependencies;
  #marketTimer: ReturnType<typeof setTimeout> | null = null;
  #brokerageTimer: ReturnType<typeof setTimeout> | null = null;
  #marketRequest: Promise<void> | null = null;
  #brokerageRequest: Promise<BrokerageSnapshot> | null = null;
  #marketAbort: AbortController | null = null;
  #brokerageAbort: AbortController | null = null;
  #started = false;
  #openedOnce = false;
  #lastManualBrokerageAt: number | null = null;
  #lastBrokerageSuccessAt = 0;

  constructor(dependencies: RefreshCoordinatorDependencies, policy: RefreshPolicy = DEFAULT_REFRESH_POLICY) {
    this.dependencies = dependencies;
    this.policy = policy;
    const cachedRefresh = Date.parse(dependencies.readPortfolio()?.fetchedAt ?? "");
    this.#lastBrokerageSuccessAt = Number.isFinite(cachedRefresh) ? cachedRefresh : 0;
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.dependencies.document?.addEventListener("visibilitychange", this.onVisibilityChange);
    if (!this.dependencies.document?.hidden) this.onVisible();
  }

  stop(): void {
    this.#started = false;
    this.dependencies.document?.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.#clearTimers();
    this.#marketAbort?.abort();
    this.#brokerageAbort?.abort();
  }

  onVisibilityChange(): void {
    if (this.dependencies.document?.hidden) this.onHidden();
    else this.onVisible();
  }

  onHidden(): void {
    this.#clearTimers();
    this.#marketAbort?.abort();
    this.#brokerageAbort?.abort();
  }

  onVisible(): void {
    if (!this.#started) return;
    const opening = !this.#openedOnce;
    this.#openedOnce = true;
    void this.refreshMarket();
    const now = (this.dependencies.now ?? Date.now)();
    const brokerageDue = this.policy.brokerageIntervalMs !== null
      && now - this.#lastBrokerageSuccessAt >= this.policy.brokerageIntervalMs;
    const refreshOnOpen = opening && this.policy.refreshBrokerageOnOpen
      && (this.policy.brokerageIntervalMs === null || this.#lastBrokerageSuccessAt === 0 || brokerageDue);
    if (refreshOnOpen || (!opening && brokerageDue)) {
      void this.refreshBrokerage();
    }
    this.#scheduleMarket();
    this.#scheduleBrokerage();
  }

  refreshMarket(): Promise<void> {
    if (this.#marketRequest) return this.#marketRequest;
    this.#marketAbort = new AbortController();
    this.#marketRequest = this.dependencies.refreshMarket(this.#marketAbort.signal)
      .catch((error) => {
        if ((error as { name?: string }).name !== "AbortError") this.dependencies.onError("market", error);
      })
      .finally(() => { this.#marketRequest = null; });
    return this.#marketRequest;
  }

  refreshBrokerage(options: { manual?: boolean } = {}): Promise<BrokerageSnapshot> {
    const now = (this.dependencies.now ?? Date.now)();
    if (options.manual && this.#lastManualBrokerageAt !== null && now - this.#lastManualBrokerageAt < this.policy.manualBrokerageCooldownMs) {
      return Promise.reject(new Error("Brokerage refresh is cooling down"));
    }
    if (this.#brokerageRequest) return this.#brokerageRequest;
    if (options.manual) this.#lastManualBrokerageAt = now;
    this.#brokerageAbort = new AbortController();
    const previous = this.dependencies.readPortfolio();
    this.#brokerageRequest = this.dependencies.refreshBrokerage(this.#brokerageAbort.signal)
      .then(async (snapshot) => {
        await this.dependencies.writePortfolio(snapshot);
        this.#lastBrokerageSuccessAt = (this.dependencies.now ?? Date.now)();
        const diff = diffPortfolio(previous, snapshot);
        if (diff.affectedSymbols.length || diff.affectedContracts.length) {
          await this.dependencies.refreshAffectedMarket(diff, this.#brokerageAbort!.signal);
        }
        return snapshot;
      })
      .catch((error) => {
        if ((error as { name?: string }).name !== "AbortError") this.dependencies.onError("brokerage", error);
        throw error;
      })
      .finally(() => { this.#brokerageRequest = null; });
    return this.#brokerageRequest;
  }

  #scheduleMarket(): void {
    if (!this.#started || this.dependencies.document?.hidden) return;
    if (this.#marketTimer) clearTimeout(this.#marketTimer);
    this.#marketTimer = setTimeout(() => {
      void this.refreshMarket().finally(() => this.#scheduleMarket());
    }, this.policy.marketIntervalMs);
  }

  #scheduleBrokerage(): void {
    if (!this.#started || this.dependencies.document?.hidden || this.policy.brokerageIntervalMs === null) return;
    if (this.#brokerageTimer) clearTimeout(this.#brokerageTimer);
    this.#brokerageTimer = setTimeout(() => {
      void this.refreshBrokerage().finally(() => this.#scheduleBrokerage());
    }, this.policy.brokerageIntervalMs);
  }

  #clearTimers(): void {
    if (this.#marketTimer) clearTimeout(this.#marketTimer);
    if (this.#brokerageTimer) clearTimeout(this.#brokerageTimer);
    this.#marketTimer = null;
    this.#brokerageTimer = null;
  }
}
