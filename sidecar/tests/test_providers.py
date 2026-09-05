import asyncio
import sys
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

import pandas as pd
import pytest

from app.providers import MarketDataProvider, ProviderUnavailable, YFinanceProvider


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


def test_yfinance_equity_quotes_fetch_all_prices_in_one_batch(monkeypatch):
    quote_time = datetime.now(UTC).replace(microsecond=0)
    columns = pd.MultiIndex.from_tuples([
        ("AAPL", "Close"),
        ("MSFT", "Close"),
    ])
    history = pd.DataFrame([[195.1, 405.3]], index=[pd.Timestamp(quote_time)], columns=columns)
    download_calls = []

    class FakeTicker:
        fast_info = {}

        def history(self, *_args, **_kwargs):
            raise AssertionError("batch prices should not be fetched again per ticker")

    def download(symbols, **kwargs):
        download_calls.append((symbols, kwargs))
        return history

    monkeypatch.setitem(sys.modules, "yfinance", SimpleNamespace(
        download=download,
        Ticker=lambda _symbol: FakeTicker(),
    ))

    results = YFinanceProvider(timeout_seconds=7)._fetch_quotes(["AAPL", "MSFT"])

    assert [result["price"] for result in results] == [195.1, 405.3]
    assert all(result["quote_time"] == quote_time for result in results)
    assert len(download_calls) == 1
    assert download_calls[0][0] == ["AAPL", "MSFT"]
    assert download_calls[0][1]["timeout"] == 7


def test_yfinance_equity_quotes_retry_missing_batch_symbols_with_daily_prices(monkeypatch):
    intraday_time = datetime.now(UTC).replace(microsecond=0)
    daily_time = intraday_time - timedelta(days=1)
    intraday = pd.DataFrame(
        [[195.1, float("nan")]],
        index=[pd.Timestamp(intraday_time)],
        columns=pd.MultiIndex.from_tuples([("AAPL", "Close"), ("MSFT", "Close")]),
    )
    daily = pd.DataFrame(
        [[405.3]],
        index=[pd.Timestamp(daily_time)],
        columns=pd.MultiIndex.from_tuples([("MSFT", "Close")]),
    )
    download_calls = []

    class FakeTicker:
        def history(self, *_args, **_kwargs):
            raise AssertionError("the daily batch should fill the missing ticker")

    def download(symbols, **kwargs):
        download_calls.append((symbols, kwargs["interval"]))
        return intraday if kwargs["interval"] == "1m" else daily

    monkeypatch.setitem(sys.modules, "yfinance", SimpleNamespace(
        download=download,
        Ticker=lambda _symbol: FakeTicker(),
    ))

    results = YFinanceProvider()._fetch_quotes(["AAPL", "MSFT"])

    assert [result["price"] for result in results] == [195.1, 405.3]
    assert [result["quote_time"] for result in results] == [intraday_time, daily_time]
    assert download_calls == [(["AAPL", "MSFT"], "1m"), (["MSFT"], "1d")]


def test_yfinance_equity_quote_keeps_price_when_optional_bid_ask_fail(monkeypatch):
    quote_time = datetime.now(UTC).replace(microsecond=0)
    history = pd.DataFrame({"Close": [67.51]}, index=[pd.Timestamp(quote_time)])

    class FakeTicker:
        @property
        def fast_info(self):
            raise RuntimeError("optional quote summary unavailable")

        def history(self, period, interval):
            assert (period, interval) == ("5d", "1m")
            return history

    def failed_batch(*_args, **_kwargs):
        raise RuntimeError("batch temporarily unavailable")

    monkeypatch.setitem(sys.modules, "yfinance", SimpleNamespace(
        download=failed_batch,
        Ticker=lambda _symbol: FakeTicker(),
    ))

    result = YFinanceProvider()._fetch_quotes(["RKLB"])[0]

    assert result["price"] == 67.51
    assert result["quote_time"] == quote_time
    assert result["bid"] is None
    assert result["ask"] is None
    assert result["error"] is None


def test_market_data_provider_delegates_to_yahoo():
    expected = SimpleNamespace(provider="yfinance")

    class FakeYahoo:
        async def fetch_chain(self, symbol, min_dte, max_dte):
            assert (symbol, min_dte, max_dte) == ("XYZ", 7, 45)
            return expected

        async def search_instruments(self, query, limit):
            return {"query": query, "limit": limit}

    provider = MarketDataProvider(yahoo=FakeYahoo())

    assert asyncio.run(provider.fetch_chain("XYZ", 7, 45)) is expected
    assert asyncio.run(provider.search_instruments("xyz", 3)) == {"query": "xyz", "limit": 3}
