const wait = (milliseconds: number, signal?: AbortSignal | null): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason);
    return;
  }
  const onAbort = () => {
    window.clearTimeout(timer);
    reject(signal?.reason ?? new DOMException("The request was aborted", "AbortError"));
  };
  const timer = window.setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, milliseconds);
  signal?.addEventListener("abort", onAbort, { once: true });
});

const requiresAuthentication = async (response: Response): Promise<boolean> => {
  if (response.status !== 401) return false;
  const payload = await response.clone().json().catch(() => null) as { error?: { code?: string } } | null;
  return payload?.error?.code === "AUTH_REQUIRED";
};

export const fetchWithAuthRecovery = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  retryDelayMs = 750,
): Promise<Response> => {
  const execute = async () => {
    const response = await fetch(input, init);
    if (!await requiresAuthentication(response)) return response;
    await wait(retryDelayMs, init.signal);
    return fetch(input, init);
  };
  const url = new URL(input instanceof Request ? input.url : input, "http://localhost");
  if (url.pathname.startsWith("/api/brokerage/") && typeof navigator !== "undefined" && navigator.locks) {
    return init.signal
      ? navigator.locks.request("wheely-snaptrade-brokerage", { signal: init.signal }, execute)
      : navigator.locks.request("wheely-snaptrade-brokerage", execute);
  }
  return execute();
};
