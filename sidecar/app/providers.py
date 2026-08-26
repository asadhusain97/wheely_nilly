import asyncio
import math
import re
from datetime import UTC, date, datetime
from typing import Protocol

import httpx

from .models import ChainSnapshot, OptionQuote


class OptionsProvider(Protocol):
    name: str

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot: ...
    async def search_instruments(self, query: str, limit: int = 8) -> dict: ...


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


def _valid_symbol(value):
    return bool(re.fullmatch(r"[A-Z][A-Z0-9.-]{0,9}", value))


_US_YAHOO_EXCHANGES = {
    "ASE", "BTS", "NCM", "NGM", "NMS", "NYQ", "OBB", "OTC", "PCX", "PNK", "YHD",
}


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
    """Official real-time options adapter with a separate underlying-price provider."""

    name = "alphavantage"
    base_url = "https://www.alphavantage.co/query"

    def __init__(self, api_key: str, underlying_provider, timeout_seconds: float = 12, client=None):
        self.api_key = api_key.strip()
        self.underlying_provider = underlying_provider
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
        options_payload, underlying_price = await asyncio.gather(
            self._request(client, {"function": "REALTIME_OPTIONS", "symbol": symbol, "require_greeks": "true"}),
            self.underlying_provider.fetch_underlying_price(symbol),
        )
        records = options_payload.get("data")
        if not isinstance(records, list) or not records:
            raise ProviderUnavailable(self.name, "no_options_data")
        underlying_price = _clean_float(underlying_price)
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
        return ChainSnapshot(provider=self.name, unofficial=False,
                             underlying_provider=self.underlying_provider.name,
                             underlying_provider_unofficial=True,
                             underlying_price=underlying_price, fetched_at=now, quotes=quotes)

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        if not self.api_key:
            raise ProviderUnavailable(self.name, "not_configured")
        if self.client is not None:
            return await self._fetch(self.client, symbol, min_dte, max_dte)
        async with httpx.AsyncClient(timeout=self.timeout, headers={"user-agent": "wheely-nilly/1.0"}) as client:
            return await self._fetch(client, symbol, min_dte, max_dte)

    async def _search(self, client, query: str, limit: int):
        payload = await self._request(client, {"function": "SYMBOL_SEARCH", "keywords": query})
        matches = []
        for record in payload.get("bestMatches", []):
            symbol = str(record.get("1. symbol", "")).strip().upper()
            name = str(record.get("2. name", "")).strip()
            instrument_type = str(record.get("3. type", "")).strip()
            region = str(record.get("4. region", "")).strip()
            currency = str(record.get("8. currency", "")).strip().upper()
            if not _valid_symbol(symbol) or not name or instrument_type.lower() not in {"equity", "etf", "mutual fund"}:
                continue
            if (region and region != "United States") or (currency and currency != "USD"):
                continue
            matches.append({"symbol": symbol, "name": name, "instrument_type": instrument_type,
                            "exchange": None, "currency": currency or None})
        return matches[:limit]

    async def search_instruments(self, query: str, limit: int = 8) -> dict:
        if not self.api_key:
            raise ProviderUnavailable(self.name, "not_configured")
        if self.client is not None:
            matches = await self._search(self.client, query, limit)
        else:
            async with httpx.AsyncClient(timeout=self.timeout, headers={"user-agent": "wheely-nilly/1.0"}) as client:
                matches = await self._search(client, query, limit)
        return {"provider": self.name, "provider_unofficial": False, "matches": matches}


class YFinanceProvider:
    """Unofficial Yahoo adapter. Blocking library work stays off the event loop."""

    name = "yfinance"
    search_url = "https://query1.finance.yahoo.com/v1/finance/search"

    def __init__(self, timeout_seconds: float = 12, search_client=None):
        self.timeout = timeout_seconds
        self.search_client = search_client

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        return await asyncio.to_thread(self._fetch, symbol, min_dte, max_dte)

    async def fetch_underlying_price(self, symbol: str) -> float:
        return await asyncio.to_thread(self._fetch_underlying_price, symbol)

    async def search_instruments(self, query: str, limit: int = 8) -> dict:
        if self.search_client is not None:
            matches = await self._search(self.search_client, query, limit)
        else:
            async with httpx.AsyncClient(timeout=self.timeout, headers={"user-agent": "wheely-nilly/1.0"}) as client:
                matches = await self._search(client, query, limit)
        return {"provider": self.name, "provider_unofficial": True, "matches": matches}

    async def _search(self, client, query: str, limit: int) -> list[dict]:
        try:
            response = await client.get(self.search_url, params={
                "q": query,
                "quotesCount": limit,
                "newsCount": 0,
                "enableFuzzyQuery": "false",
            })
        except httpx.TimeoutException as error:
            raise ProviderUnavailable(self.name, "timeout") from error
        except httpx.HTTPError as error:
            raise ProviderUnavailable(self.name, "network_error") from error
        if response.status_code == 429:
            raise ProviderUnavailable(self.name, "rate_limited")
        if response.status_code >= 400:
            raise ProviderUnavailable(self.name, "http_error")
        try:
            payload = response.json()
        except ValueError as error:
            raise ProviderUnavailable(self.name, "invalid_response") from error
        records = payload.get("quotes") if isinstance(payload, dict) else None
        if not isinstance(records, list):
            raise ProviderUnavailable(self.name, "invalid_response")
        matches = []
        for record in records:
            if not isinstance(record, dict):
                continue
            instrument_type = str(record.get("quoteType", "")).upper()
            if instrument_type not in {"EQUITY", "ETF", "MUTUALFUND"}:
                continue
            exchange_code = str(record.get("exchange", "")).upper()
            if exchange_code not in _US_YAHOO_EXCHANGES:
                continue
            symbol = str(record.get("symbol", "")).strip().upper()
            name = str(record.get("longname") or record.get("shortname") or "").strip()
            if not _valid_symbol(symbol) or not name:
                continue
            matches.append({"symbol": symbol, "name": name,
                            "instrument_type": {"EQUITY": "Equity", "ETF": "ETF", "MUTUALFUND": "Mutual Fund"}[instrument_type],
                            "exchange": record.get("exchDisp") or record.get("exchange"), "currency": None})
        return matches[:limit]

    @staticmethod
    def _price_from_ticker(ticker) -> float:
        history = ticker.history(period="2d")
        if history.empty:
            raise ProviderUnavailable("yfinance", "no_underlying_quote")
        return float(history["Close"].dropna().iloc[-1])

    @staticmethod
    def _fetch_underlying_price(symbol: str) -> float:
        import yfinance as yf

        ticker = yf.Ticker(symbol)
        return YFinanceProvider._price_from_ticker(ticker)

    @staticmethod
    def _fetch(symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        import yfinance as yf

        ticker = yf.Ticker(symbol)
        price = YFinanceProvider._price_from_ticker(ticker)
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
        return ChainSnapshot(provider="yfinance", unofficial=True,
                             underlying_provider="yfinance", underlying_provider_unofficial=True,
                             underlying_price=price, fetched_at=now, quotes=quotes)


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

    async def search_instruments(self, query: str, limit: int = 8) -> dict:
        failures = []
        for provider in self.providers:
            try:
                result = await provider.search_instruments(query, limit)
                if failures:
                    failed_provider, code = failures[0]
                    result["degraded"] = True
                    result["warning"] = f"{failed_provider} {_FAILURE_LABELS.get(code, 'was unavailable')}; using {result['provider']} fallback"
                else:
                    result["degraded"], result["warning"] = False, None
                return result
            except Exception as error:
                failures.append((provider.name, getattr(error, "code", "unexpected_error")))
        raise ProviderUnavailable(self.name, "all_providers_failed")


def build_provider_chain(names: str, alpha_vantage_key: str, timeout_seconds=15):
    yfinance = YFinanceProvider(timeout_seconds=timeout_seconds)
    providers = []
    for name in [item.strip().lower() for item in names.split(",") if item.strip()]:
        if name == "alphavantage":
            providers.append(AlphaVantageProvider(alpha_vantage_key, yfinance))
        elif name == "yfinance":
            providers.append(yfinance)
        else:
            raise ValueError(f"Unsupported screener provider: {name}")
    return FallbackProvider(providers, timeout_seconds=timeout_seconds)
