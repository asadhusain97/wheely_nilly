import asyncio
import math
from datetime import UTC, date, datetime
from typing import Protocol

from .models import ChainSnapshot, OptionQuote


class OptionsProvider(Protocol):
    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot: ...


class YFinanceProvider:
    """Unofficial Yahoo adapter. Blocking library work stays off the event loop."""

    async def fetch_chain(self, symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        return await asyncio.to_thread(self._fetch, symbol, min_dte, max_dte)

    @staticmethod
    def _fetch(symbol: str, min_dte: int, max_dte: int) -> ChainSnapshot:
        import yfinance as yf

        ticker = yf.Ticker(symbol)
        history = ticker.history(period="2d")
        if history.empty:
            raise RuntimeError("provider returned no underlying price")
        price = float(history["Close"].dropna().iloc[-1])
        now = datetime.now(UTC)
        quotes: list[OptionQuote] = []
        expirations = [expiration for expiration in ticker.options if min_dte <= (date.fromisoformat(expiration) - now.date()).days <= max_dte]
        for expiration in expirations:
            chain = ticker.option_chain(expiration)
            for option_type, frame in (("call", chain.calls), ("put", chain.puts)):
                for record in frame.to_dict("records"):
                    clean = lambda value: None if value is None or (isinstance(value, float) and not math.isfinite(value)) else value
                    quotes.append(OptionQuote(symbol=str(record.get("contractSymbol", "")), option_type=option_type,
                        expiration=expiration, strike=record["strike"], bid=clean(record.get("bid")), ask=clean(record.get("ask")),
                        last=clean(record.get("lastPrice")), volume=clean(record.get("volume")), open_interest=clean(record.get("openInterest")),
                        implied_volatility=clean(record.get("impliedVolatility")), quote_time=now))
        return ChainSnapshot(provider="yfinance", unofficial=True, underlying_price=price, fetched_at=now, quotes=quotes)
