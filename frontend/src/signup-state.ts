const OAUTH_NOTICES: Record<string, string> = {
  access_denied: "Connection canceled. Nothing was shared. Start again when you’re ready.",
  invalid_state: "The connection window expired or was opened twice. Start again from this page.",
  missing_code: "SnapTrade returned without finishing the connection. Start again below.",
  unavailable: "SnapTrade could not start the connection right now. Try again in a moment.",
};

export function signupNotice(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("setup") === "restarted") return "The previous connection was cleared. You can begin again below.";
  const oauth = params.get("oauth");
  if (oauth) return OAUTH_NOTICES[oauth] ?? "SnapTrade did not finish the connection. Try again below.";
  return null;
}

export function shouldOpenSignupGuide(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get("connect") === "1" || params.has("oauth") || params.get("setup") === "restarted";
}
