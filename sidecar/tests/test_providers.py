import asyncio
import sys
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pandas as pd
import pytest

from app.providers import ProviderUnavailable, YFinanceProvider


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload


def test_yfinance_search_limits_results_to_us_exchanges():
    class FakeYahooClient:
        def __init__(self):
            self.calls = []

        async def get(self, url, params):
            self.calls.append((url, params))
            return FakeResponse({"quotes": [
                {"symbol": "AAPL", "longname": "Apple Inc.", "quoteType": "EQUITY", "exchange": "NMS", "exchDisp": "NASDAQ"},
                {"symbol": "AAPL19.BK", "longname": "Apple Inc.", "quoteType": "EQUITY", "exchange": "SET", "exchDisp": "Thailand"},
            ]})

    client = FakeYahooClient()
    provider = YFinanceProvider(search_client=client)

    result = asyncio.run(provider.search_instruments("AAPL", 8))

    assert result == {
        "provider": "yfinance",
        "provider_unofficial": True,
        "matches": [{
            "symbol": "AAPL",
            "name": "Apple Inc.",
            "instrument_type": "Equity",
            "exchange": "NASDAQ",
            "currency": None,
        }],
    }
    assert client.calls[0][0] == YFinanceProvider.search_url
    assert client.calls[0][1]["q"] == "AAPL"


def test_yfinance_search_rejects_malformed_quotes_without_leaking_type_error():
    class FakeYahooClient:
        async def get(self, _url, params):
            return FakeResponse({"quotes": None})

    provider = YFinanceProvider(search_client=FakeYahooClient())

    with pytest.raises(ProviderUnavailable) as raised:
        asyncio.run(provider.search_instruments("AAPL"))
    assert raised.value.code == "invalid_response"


def test_yfinance_chain_uses_yahoo_trade_time_and_preserves_missing_liquidity(monkeypatch):
    expiration = date.today() + timedelta(days=21)
    trade_time = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=2)
    calls = pd.DataFrame([{
        "contractSymbol": "XYZ260918C00105000",
        "strike": 105,
        "bid": 1.0,
        "ask": 1.1,
        "lastPrice": 1.05,
        "volume": float("nan"),
        "openInterest": None,
        "impliedVolatility": 0.3,
        "lastTradeDate": pd.Timestamp(trade_time),
    }])

    class FakeTicker:
        options = (expiration.isoformat(),)

        def history(self, period):
            assert period == "2d"
            return pd.DataFrame({"Close": [100.0]})

        def option_chain(self, requested_expiration):
            assert requested_expiration == expiration.isoformat()
            return SimpleNamespace(calls=calls, puts=pd.DataFrame())

    monkeypatch.setitem(sys.modules, "yfinance", SimpleNamespace(Ticker=lambda _symbol: FakeTicker()))

    snapshot = YFinanceProvider._fetch("XYZ", 7, 45)

    assert snapshot.provider == "yfinance"
    assert snapshot.unofficial is True
    assert snapshot.underlying_price == 100
    assert snapshot.quotes[0].quote_time == trade_time
    assert snapshot.quotes[0].volume is None
    assert snapshot.quotes[0].open_interest is None


def test_yfinance_chain_preserves_missing_trade_time(monkeypatch):
    expiration = date.today() + timedelta(days=21)
    calls = pd.DataFrame([{
        "contractSymbol": "XYZ260918C00105000",
        "strike": 105,
        "bid": 1.0,
        "ask": 1.1,
        "lastPrice": 1.05,
        "volume": 10,
        "openInterest": 100,
        "impliedVolatility": 0.3,
        "lastTradeDate": pd.NaT,
    }])

    class FakeTicker:
        options = (expiration.isoformat(),)

        def history(self, period):
            assert period == "2d"
            return pd.DataFrame({"Close": [100.0]})

        def option_chain(self, _expiration):
            return SimpleNamespace(calls=calls, puts=pd.DataFrame())

    monkeypatch.setitem(sys.modules, "yfinance", SimpleNamespace(Ticker=lambda _symbol: FakeTicker()))

    snapshot = YFinanceProvider._fetch("XYZ", 7, 45)

    assert snapshot.quotes[0].quote_time is None
