import asyncio
import math
import re
from datetime import UTC, date, datetime

import httpx

from .models import ChainSnapshot, OptionQuote


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


def _clean_datetime(value):
    if value is None:
        return None
    try:
        if value != value:
            return None
        if hasattr(value, "to_pydatetime"):
            value = value.to_pydatetime()
        if isinstance(value, str):
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if not isinstance(value, datetime):
            return None
        value = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
        return value if math.isfinite(value.timestamp()) else None
    except (OSError, OverflowError, TypeError, ValueError):
        return None


def _valid_symbol(value):
    return bool(re.fullmatch(r"[A-Z][A-Z0-9.-]{0,9}", value))


_US_YAHOO_EXCHANGES = {
    "ASE", "BTS", "NCM", "NGM", "NMS", "NYQ", "OBB", "OTC", "PCX", "PNK", "YHD",
}

class YFinanceProvider:
    """Yahoo market-data adapter. Blocking yfinance work stays off the event loop."""

    name = "yfinance"
    search_url = "https://query1.finance.yahoo.com/v1/finance/search"

    def __init__(self, timeout_seconds: float = 12, search_client=None):
        self.timeout = timeout_seconds
        self.search_client = search_client

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        return await asyncio.to_thread(self._fetch, symbol, min_dte, max_dte)

    async def fetch_quotes(self, symbols: list[str]) -> list[dict]:
        return await asyncio.to_thread(self._fetch_quotes, symbols)

    async def available_expirations(self, symbol: str) -> list[str]:
        return await asyncio.to_thread(self._available_expirations, symbol)

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
            matches.append({
                "symbol": symbol,
                "name": name,
                "instrument_type": {"EQUITY": "Equity", "ETF": "ETF", "MUTUALFUND": "Mutual Fund"}[instrument_type],
                "exchange": record.get("exchDisp") or record.get("exchange"),
                "currency": None,
            })
        return matches[:limit]

    @staticmethod
    def _price_from_history(history, symbol: str | None = None) -> tuple[float, datetime] | None:
        if history is None or history.empty:
            return None
        frame = history
        columns = getattr(frame, "columns", None)
        if getattr(columns, "nlevels", 1) > 1:
            if symbol in columns.get_level_values(0):
                frame = frame[symbol]
            elif symbol in columns.get_level_values(1):
                frame = frame.xs(symbol, axis=1, level=1)
            else:
                return None
        if "Close" not in frame:
            return None
        closes = frame["Close"].dropna()
        if closes.empty:
            return None
        price = _clean_float(closes.iloc[-1])
        quote_time = _clean_datetime(closes.index[-1])
        if price is None or price <= 0 or quote_time is None:
            return None
        return price, quote_time

    @staticmethod
    def _price_from_ticker(ticker) -> tuple[float, datetime]:
        last_error = None
        for period, interval in (("5d", "1m"), ("1mo", "1d")):
            try:
                price = YFinanceProvider._price_from_history(ticker.history(period=period, interval=interval))
                if price is not None:
                    return price
            except Exception as error:
                last_error = error
        raise ProviderUnavailable("yfinance", "no_underlying_quote") from last_error

    @staticmethod
    def _fetch(symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        import yfinance as yf

        ticker = yf.Ticker(symbol)
        price, price_time = YFinanceProvider._price_from_ticker(ticker)
        now = datetime.now(UTC)
        quotes: list[OptionQuote] = []
        expirations = [
            expiration for expiration in ticker.options
            if min_dte <= (date.fromisoformat(expiration) - now.date()).days <= max_dte
        ]
        for expiration_text in expirations:
            expiration = date.fromisoformat(expiration_text)
            chain = ticker.option_chain(expiration_text)
            for option_type, frame in (("call", chain.calls), ("put", chain.puts)):
                for record in frame.to_dict("records"):
                    quotes.append(OptionQuote(
                        symbol=str(record.get("contractSymbol", "")),
                        option_type=option_type,
                        expiration=expiration,
                        strike=record["strike"],
                        bid=_clean_float(record.get("bid")),
                        ask=_clean_float(record.get("ask")),
                        last=_clean_float(record.get("lastPrice")),
                        volume=_clean_int(record.get("volume")),
                        open_interest=_clean_int(record.get("openInterest")),
                        implied_volatility=_clean_float(record.get("impliedVolatility")),
                        quote_time=_clean_datetime(record.get("lastTradeDate")),
                    ))
        return ChainSnapshot(
            provider=YFinanceProvider.name,
            unofficial=True,
            underlying_price=price,
            underlying_quote_time=price_time,
            fetched_at=now,
            quotes=quotes,
        )

    @staticmethod
    def _available_expirations(symbol: str) -> list[str]:
        import yfinance as yf

        return list(yf.Ticker(symbol).options)

    def _fetch_quotes(self, symbols: list[str]) -> list[dict]:
        import yfinance as yf

        results = []
        fetched_at = datetime.now(UTC)
        batch_prices = {}
        missing = list(symbols)
        for period, interval in (("5d", "1m"), ("1mo", "1d")):
            try:
                history = yf.download(
                    missing,
                    period=period,
                    interval=interval,
                    group_by="ticker",
                    auto_adjust=False,
                    threads=True,
                    progress=False,
                    timeout=self.timeout,
                    multi_level_index=True,
                )
                for symbol in missing:
                    price = self._price_from_history(history, symbol)
                    if price is not None:
                        batch_prices[symbol] = price
            except Exception:
                pass
            missing = [symbol for symbol in missing if symbol not in batch_prices]
            if not missing:
                break
        for symbol in symbols:
            try:
                price, quote_time = batch_prices.get(symbol) or self._price_from_ticker(yf.Ticker(symbol))
                results.append({
                    "symbol": symbol,
                    "price": price,
                    "bid": None,
                    "ask": None,
                    "quote_time": quote_time,
                    "fetched_at": fetched_at,
                    "provider": YFinanceProvider.name,
                    "unofficial": True,
                    "error": None,
                })
            except Exception as error:
                results.append({
                    "symbol": symbol,
                    "price": None,
                    "bid": None,
                    "ask": None,
                    "quote_time": None,
                    "fetched_at": fetched_at,
                    "provider": YFinanceProvider.name,
                    "unofficial": True,
                    "error": {"code": "PROVIDER_UNAVAILABLE", "message": f"Quote unavailable ({type(error).__name__})"},
                })
        return results


class MarketDataProvider:
    """Provider boundary for Wheely Nilly market data."""

    name = YFinanceProvider.name

    def __init__(self, timeout_seconds: float = 12, yahoo=None):
        self.yahoo = yahoo or YFinanceProvider(timeout_seconds=timeout_seconds)

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        return await self.yahoo.fetch_chain(symbol, min_dte, max_dte)

    async def search_instruments(self, query: str, limit: int = 8) -> dict:
        return await self.yahoo.search_instruments(query, limit)

    async def fetch_quotes(self, symbols: list[str]) -> list[dict]:
        return await self.yahoo.fetch_quotes(symbols)

    async def available_expirations(self, symbol: str) -> list[str]:
        return await self.yahoo.available_expirations(symbol)
