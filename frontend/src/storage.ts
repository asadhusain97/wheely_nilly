export const STORAGE_SCHEMA_VERSION = 1;
export const STORAGE_DOMAINS = [
  "userPreferences",
  "tickerStrategies",
  "radarConfig",
  "portfolioSnapshot",
  "eventLedger",
  "marketCache",
  "radarCache",
  "appSettings",
  "watchlists",
  "dismissedCandidates",
  "refreshMetadata",
] as const;

export type StorageDomain = (typeof STORAGE_DOMAINS)[number];

export interface StoredRecord<T> {
  key: string;
  value: T;
  updatedAt: string;
  schemaVersion: number;
}

export class BrowserStorageUnavailableError extends Error {
  constructor(message = "Local browser storage is unavailable") {
    super(message);
    this.name = "BrowserStorageUnavailableError";
  }
}

export class LocalRepository {
  readonly databaseName: string;
  #openPromise: Promise<IDBDatabase> | null = null;

  constructor(databaseName = "wheely-nilly") {
    this.databaseName = databaseName;
  }

  #open(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB) return Promise.reject(new BrowserStorageUnavailableError());
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, STORAGE_SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const domain of STORAGE_DOMAINS) {
          if (!database.objectStoreNames.contains(domain)) database.createObjectStore(domain, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new BrowserStorageUnavailableError(request.error?.message));
      request.onblocked = () => reject(new BrowserStorageUnavailableError("Close other Wheely Nilly tabs and try again"));
    });
    return this.#openPromise;
  }

  async get<T>(domain: StorageDomain, key: string): Promise<StoredRecord<T> | null> {
    const database = await this.#open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(domain, "readonly").objectStore(domain).get(key);
      request.onsuccess = () => resolve((request.result as StoredRecord<T> | undefined) ?? null);
      request.onerror = () => reject(new BrowserStorageUnavailableError(request.error?.message));
    });
  }

  async put<T>(domain: StorageDomain, key: string, value: T): Promise<StoredRecord<T>> {
    const record: StoredRecord<T> = { key, value, updatedAt: new Date().toISOString(), schemaVersion: STORAGE_SCHEMA_VERSION };
    const database = await this.#open();
    return new Promise((resolve, reject) => {
      const request = database.transaction(domain, "readwrite").objectStore(domain).put(record);
      request.onsuccess = () => resolve(record);
      request.onerror = () => reject(new BrowserStorageUnavailableError(request.error?.message));
    });
  }

  async delete(domain: StorageDomain, key: string): Promise<void> {
    const database = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(domain, "readwrite").objectStore(domain).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new BrowserStorageUnavailableError(request.error?.message));
    });
  }

  async clearFinancialData(): Promise<void> {
    await this.#clearDomains(["portfolioSnapshot", "eventLedger", "marketCache", "radarCache", "refreshMetadata"]);
  }

  async clearAllData(): Promise<void> {
    await this.#clearDomains([...STORAGE_DOMAINS]);
  }

  async #clearDomains(domains: StorageDomain[]): Promise<void> {
    const database = await this.#open();
    await Promise.all(domains.map((domain) => new Promise<void>((resolve, reject) => {
      const request = database.transaction(domain, "readwrite").objectStore(domain).clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new BrowserStorageUnavailableError(request.error?.message));
    })));
  }
}

export const localRepository = new LocalRepository();
