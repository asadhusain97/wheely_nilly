import asyncio
import sys
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pandas as pd
import pytest

from app.providers import CboeProvider, MarketDataProvider, ProviderUnavailable, YFinanceProvider


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
    price_time = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=15)
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

        def history(self, period, interval):
            assert (period, interval) == ("5d", "1m")
            return pd.DataFrame({"Close": [100.0]}, index=[pd.Timestamp(price_time)])

        def option_chain(self, requested_expiration):
            assert requested_expiration == expiration.isoformat()
            return SimpleNamespace(calls=calls, puts=pd.DataFrame())

    monkeypatch.setitem(sys.modules, "yfinance", SimpleNamespace(Ticker=lambda _symbol: FakeTicker()))

    snapshot = YFinanceProvider._fetch("XYZ", 7, 45)

    assert snapshot.provider == "yfinance"
    assert snapshot.unofficial is True
    assert snapshot.underlying_price == 100
    assert snapshot.underlying_quote_time == price_time
    assert snapshot.quotes[0].quote_time == trade_time
    assert snapshot.quotes[0].volume is None
    assert snapshot.quotes[0].open_interest is None


def test_yfinance_chain_preserves_missing_trade_time(monkeypatch):
    expiration = date.today() + timedelta(days=21)
    price_time = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=15)
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

        def history(self, period, interval):
            assert (period, interval) == ("5d", "1m")
            return pd.DataFrame({"Close": [100.0]}, index=[pd.Timestamp(price_time)])

        def option_chain(self, _expiration):
            return SimpleNamespace(calls=calls, puts=pd.DataFrame())

    monkeypatch.setitem(sys.modules, "yfinance", SimpleNamespace(Ticker=lambda _symbol: FakeTicker()))

    snapshot = YFinanceProvider._fetch("XYZ", 7, 45)

    assert snapshot.quotes[0].quote_time is None


def test_yfinance_chain_supports_contracts_expiring_today(monkeypatch):
    price_time = datetime.now(UTC).replace(microsecond=0)
    expiration = price_time.date()
    contract_symbol = f"XYZ{expiration:%y%m%d}P00095000"
    puts = pd.DataFrame([{
        "contractSymbol": contract_symbol, "strike": 95, "bid": 2, "ask": 2.1,
        "lastPrice": 2.05, "volume": 1, "openInterest": 1, "impliedVolatility": .3,
        "lastTradeDate": pd.Timestamp(price_time),
    }])

    class FakeTicker:
        options = (expiration.isoformat(),)

        def history(self, period, interval):
            return pd.DataFrame({"Close": [100.0]}, index=[pd.Timestamp(price_time)])

        def option_chain(self, requested_expiration):
            assert requested_expiration == expiration.isoformat()
            return SimpleNamespace(calls=pd.DataFrame(), puts=puts)

    monkeypatch.setitem(sys.modules, "yfinance", SimpleNamespace(Ticker=lambda _symbol: FakeTicker()))
    result = YFinanceProvider._fetch("XYZ", 0, 0)
    assert [quote.symbol for quote in result.quotes] == [contract_symbol]


def test_cboe_chain_parses_occ_contracts_and_eastern_trade_times():
    expiration = date.today() + timedelta(days=21)
    contract_symbol = f"XYZ{expiration:%y%m%d}P00095000"

    class FakeCboeClient:
        async def get(self, url):
            assert url == "https://cdn.cboe.com/api/global/delayed_quotes/options/XYZ.json"
            return FakeResponse({
                "timestamp": "2026-08-28 03:44:44",
                "data": {
                    "symbol": "XYZ",
                    "current_price": 100.25,
                    "last_trade_time": "2026-08-27T15:59:59",
                    "options": [{
                        "option": contract_symbol,
                        "bid": 2.0,
                        "ask": 2.1,
                        "last_trade_price": 2.05,
                        "volume": 12.0,
                        "open_interest": 345.0,
                        "iv": 0.3,
                        "last_trade_time": "2026-08-27T15:58:30",
                    }],
                },
            })

    snapshot = asyncio.run(CboeProvider(chain_client=FakeCboeClient()).fetch_chain("XYZ", 7, 45))

    assert snapshot.provider == "cboe_delayed"
    assert snapshot.unofficial is False
    assert snapshot.underlying_price == 100.25
    assert snapshot.underlying_quote_time == datetime(2026, 8, 27, 19, 59, 59, tzinfo=UTC)
    assert snapshot.quotes[0].symbol == contract_symbol
    assert snapshot.quotes[0].option_type == "put"
    assert snapshot.quotes[0].strike == 95
    assert snapshot.quotes[0].bid == 2
    assert snapshot.quotes[0].ask == 2.1
    assert snapshot.quotes[0].open_interest == 345
    assert snapshot.quotes[0].quote_time == datetime(2026, 8, 27, 19, 58, 30, tzinfo=UTC)


def test_cboe_rejects_a_malformed_chain():
    class FakeCboeClient:
        async def get(self, _url):
            return FakeResponse({"data": {"current_price": 100, "options": None}})

    with pytest.raises(ProviderUnavailable) as raised:
        asyncio.run(CboeProvider(chain_client=FakeCboeClient()).fetch_chain("XYZ", 7, 45))
    assert raised.value.code == "invalid_response"


def test_market_data_provider_falls_back_to_yahoo_when_cboe_is_unavailable():
    expected = SimpleNamespace(provider="yfinance")

    class UnavailableCboe:
        async def fetch_chain(self, _symbol, _min_dte, _max_dte):
            raise ProviderUnavailable("cboe_delayed", "network_error")

    class FakeYahoo:
        async def fetch_chain(self, symbol, min_dte, max_dte):
            assert (symbol, min_dte, max_dte) == ("XYZ", 7, 45)
            return expected

        async def search_instruments(self, query, limit):
            return {"query": query, "limit": limit}

    provider = MarketDataProvider(cboe=UnavailableCboe(), yahoo=FakeYahoo())

    assert asyncio.run(provider.fetch_chain("XYZ", 7, 45)) is expected
    assert asyncio.run(provider.search_instruments("xyz", 3)) == {"query": "xyz", "limit": 3}


def test_market_data_provider_uses_cboe_without_calling_yahoo_for_option_chains():
    expected = SimpleNamespace(provider="cboe_delayed")

    class FakeCboe:
        async def fetch_chain(self, symbol, min_dte, max_dte):
            assert (symbol, min_dte, max_dte) == ("XYZ", 7, 45)
            return expected

    class UnexpectedYahoo:
        async def fetch_chain(self, _symbol, _min_dte, _max_dte):
            raise AssertionError("Yahoo should not run when Cboe succeeds")

    provider = MarketDataProvider(cboe=FakeCboe(), yahoo=UnexpectedYahoo())

    assert asyncio.run(provider.fetch_chain("XYZ", 7, 45)) is expected
