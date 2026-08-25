import asyncio
import math
from datetime import UTC, date, datetime
from typing import Protocol

import httpx

from .models import ChainSnapshot, OptionQuote


class OptionsProvider(Protocol):
    name: str

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot: ...


class ProviderUnavailable(RuntimeError):
    def __init__(self, provider: str, code: str):
        super().__init__(f"{provider} unavailable ({code})")
        self.provider = provider
        self.code = code


def _clean_float(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _clean_int(value):
    parsed = _clean_float(value)
    return int(parsed) if parsed is not None and parsed >= 0 else None


def _alpha_error_code(payload):
    messages = " ".join(str(payload.get(key, "")) for key in ("Error Message", "Information", "Note", "message")).strip().lower()
    if not messages:
        return None
    if "rate limit" in messages or "call frequency" in messages or "requests per day" in messages:
        return "rate_limited"
    if "premium" in messages or "entitlement" in messages:
        return "entitlement_required"
    if "api key" in messages or "apikey" in messages:
        return "authentication_failed"
    return "invalid_response"


class AlphaVantageProvider:
    """Official real-time options adapter. Chain and spot requests run concurrently."""

    name = "alphavantage"
    base_url = "https://www.alphavantage.co/query"

    def __init__(self, api_key: str, timeout_seconds: float = 12, client=None):
        self.api_key = api_key.strip()
        self.timeout = timeout_seconds
        self.client = client

    async def _request(self, client, params):
        try:
            response = await client.get(self.base_url, params={**params, "apikey": self.api_key})
        except httpx.TimeoutException as error:
            raise ProviderUnavailable(self.name, "timeout") from error
        except httpx.HTTPError as error:
            raise ProviderUnavailable(self.name, "network_error") from error
        if response.status_code == 429:
            raise ProviderUnavailable(self.name, "rate_limited")
        if response.status_code in (401, 403):
            raise ProviderUnavailable(self.name, "authentication_failed")
        if response.status_code >= 400:
            raise ProviderUnavailable(self.name, "http_error")
        try:
            payload = response.json()
        except ValueError as error:
            raise ProviderUnavailable(self.name, "invalid_response") from error
        if not isinstance(payload, dict):
            raise ProviderUnavailable(self.name, "invalid_response")
        if code := _alpha_error_code(payload):
            raise ProviderUnavailable(self.name, code)
        return payload

    async def _fetch(self, client, symbol: str, min_dte: int, max_dte: int):
        options_payload, quote_payload = await asyncio.gather(
            self._request(client, {"function": "REALTIME_OPTIONS", "symbol": symbol, "require_greeks": "true"}),
            self._request(client, {"function": "GLOBAL_QUOTE", "symbol": symbol, "entitlement": "realtime"}),
        )
        records = options_payload.get("data")
        if not isinstance(records, list) or not records:
            raise ProviderUnavailable(self.name, "no_options_data")
        global_quote = quote_payload.get("Global Quote")
        if not isinstance(global_quote, dict):
            raise ProviderUnavailable(self.name, "no_underlying_quote")
        underlying_price = _clean_float(global_quote.get("05. price") or global_quote.get("price"))
        if underlying_price is None or underlying_price <= 0:
            raise ProviderUnavailable(self.name, "no_underlying_quote")

        now = datetime.now(UTC)
        quotes = []
        for record in records:
            if not isinstance(record, dict):
                continue
            try:
                expiration = date.fromisoformat(str(record.get("expiration")))
            except ValueError:
                continue
            dte = (expiration - now.date()).days
            option_type = str(record.get("type", "")).lower()
            strike = _clean_float(record.get("strike"))
            symbol_id = str(record.get("contractID", "")).strip()
            if not min_dte <= dte <= max_dte or option_type not in ("call", "put") or not symbol_id or not strike or strike <= 0:
                continue
            quotes.append(OptionQuote(
                symbol=symbol_id,
                option_type=option_type,
                expiration=expiration,
                strike=strike,
                bid=_clean_float(record.get("bid")),
                ask=_clean_float(record.get("ask")),
                last=_clean_float(record.get("last")),
                volume=_clean_int(record.get("volume")),
                open_interest=_clean_int(record.get("open_interest")),
                implied_volatility=_clean_float(record.get("implied_volatility")),
                delta=_clean_float(record.get("delta")),
                theta=_clean_float(record.get("theta")),
                quote_time=now,
            ))
        if not quotes:
            raise ProviderUnavailable(self.name, "no_options_data")
        return ChainSnapshot(provider=self.name, unofficial=False, underlying_price=underlying_price, fetched_at=now, quotes=quotes)

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        if not self.api_key:
            raise ProviderUnavailable(self.name, "not_configured")
        if self.client is not None:
            return await self._fetch(self.client, symbol, min_dte, max_dte)
        async with httpx.AsyncClient(timeout=self.timeout, headers={"user-agent": "wheely-nilly/1.0"}) as client:
            return await self._fetch(client, symbol, min_dte, max_dte)


class YFinanceProvider:
    """Unofficial Yahoo adapter. Blocking library work stays off the event loop."""

    name = "yfinance"

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        return await asyncio.to_thread(self._fetch, symbol, min_dte, max_dte)

    @staticmethod
    def _fetch(symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        import yfinance as yf

        ticker = yf.Ticker(symbol)
        history = ticker.history(period="2d")
        if history.empty:
            raise ProviderUnavailable("yfinance", "no_underlying_quote")
        price = float(history["Close"].dropna().iloc[-1])
        now = datetime.now(UTC)
        quotes: list[OptionQuote] = []
        expirations = [expiration for expiration in ticker.options if min_dte <= (date.fromisoformat(expiration) - now.date()).days <= max_dte]
        for expiration in expirations:
            chain = ticker.option_chain(expiration)
            for option_type, frame in (("call", chain.calls), ("put", chain.puts)):
                for record in frame.to_dict("records"):
                    quotes.append(OptionQuote(symbol=str(record.get("contractSymbol", "")), option_type=option_type,
                        expiration=expiration, strike=record["strike"], bid=_clean_float(record.get("bid")), ask=_clean_float(record.get("ask")),
                        last=_clean_float(record.get("lastPrice")), volume=_clean_int(record.get("volume")), open_interest=_clean_int(record.get("openInterest")),
                        implied_volatility=_clean_float(record.get("impliedVolatility")), quote_time=now))
        return ChainSnapshot(provider="yfinance", unofficial=True, underlying_price=price, fetched_at=now, quotes=quotes)


_FAILURE_LABELS = {
    "not_configured": "is not configured",
    "rate_limited": "rate limit was reached",
    "entitlement_required": "real-time options entitlement is required",
    "authentication_failed": "authentication failed",
    "timeout": "timed out",
    "network_error": "could not be reached",
    "no_options_data": "returned no options data",
    "no_underlying_quote": "returned no underlying quote",
    "invalid_response": "returned an invalid response",
    "http_error": "returned an HTTP error",
}


class FallbackProvider:
    name = "provider_chain"

    def __init__(self, providers, timeout_seconds=15):
        if not providers:
            raise ValueError("At least one screener provider is required")
        self.providers = providers
        self.provider_names = [provider.name for provider in providers]
        self.timeout = timeout_seconds

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        failures = []
        deadline = asyncio.get_running_loop().time() + self.timeout
        for index, provider in enumerate(self.providers):
            try:
                remaining = max(0, deadline - asyncio.get_running_loop().time())
                attempt_timeout = remaining / (len(self.providers) - index)
                snapshot = await asyncio.wait_for(provider.fetch_chain(symbol, min_dte, max_dte), attempt_timeout)
                if failures:
                    failed_provider, code = failures[0]
                    reason = _FAILURE_LABELS.get(code, "was unavailable")
                    snapshot.degraded = True
                    snapshot.warning = f"{failed_provider} {reason}; using {snapshot.provider} fallback"
                return snapshot
            except TimeoutError:
                failures.append((provider.name, "timeout"))
            except Exception as error:
                failures.append((provider.name, getattr(error, "code", "unexpected_error")))
        raise ProviderUnavailable(self.name, "all_providers_failed")


def build_provider_chain(names: str, alpha_vantage_key: str, timeout_seconds=15):
    providers = []
    for name in [item.strip().lower() for item in names.split(",") if item.strip()]:
        if name == "alphavantage":
            providers.append(AlphaVantageProvider(alpha_vantage_key))
        elif name == "yfinance":
            providers.append(YFinanceProvider())
        else:
            raise ValueError(f"Unsupported screener provider: {name}")
    return FallbackProvider(providers, timeout_seconds=timeout_seconds)
