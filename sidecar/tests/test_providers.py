import asyncio
from datetime import UTC, date, datetime, timedelta

import pytest

from app.models import ChainSnapshot, ScreenRequest
from app.providers import AlphaVantageProvider, FallbackProvider, ProviderUnavailable, build_provider_chain
from app.screener import ScreenerService


class FakeResponse:
    def __init__(self, payload, status_code=200):
        self.payload = payload
        self.status_code = status_code

    def json(self):
        return self.payload


class FakeAlphaClient:
    def __init__(self, options):
        self.options = options
        self.calls = []

    async def get(self, _url, params):
        self.calls.append(params)
        await asyncio.sleep(0)
        return FakeResponse(self.options)


class StubUnderlyingProvider:
    name = "yfinance"

    def __init__(self, price=101.25):
        self.price = price
        self.calls = []

    async def fetch_underlying_price(self, symbol):
        self.calls.append(symbol)
        return self.price


def option_record(expiration):
    return {
        "contractID": "XYZ261218P00095000",
        "expiration": expiration.isoformat(),
        "strike": "95.00",
        "type": "put",
        "last": "2.02",
        "bid": "2.00",
        "ask": "2.10",
        "volume": "120",
        "open_interest": "450",
        "implied_volatility": "0.31",
        "delta": "-0.28",
        "theta": "-0.04",
    }


def test_alpha_vantage_fetches_only_options_while_yahoo_supplies_spot():
    expiration = datetime.now(UTC).date() + timedelta(days=21)
    client = FakeAlphaClient({"data": [option_record(expiration)]})
    underlying = StubUnderlyingProvider()
    provider = AlphaVantageProvider("alpha-key", underlying, client=client)

    snapshot = asyncio.run(provider.fetch_chain("XYZ", 7, 45))

    assert snapshot.provider == "alphavantage"
    assert snapshot.unofficial is False
    assert snapshot.underlying_provider == "yfinance"
    assert snapshot.underlying_provider_unofficial is True
    assert snapshot.underlying_price == 101.25
    assert len(snapshot.quotes) == 1
    assert snapshot.quotes[0].delta == -0.28
    assert [call["function"] for call in client.calls] == ["REALTIME_OPTIONS"]
    assert client.calls[0]["require_greeks"] == "true"
    assert underlying.calls == ["XYZ"]


def test_alpha_vantage_classifies_limits_without_using_sample_data():
    client = FakeAlphaClient(
        {"Note": "Thank you for using Alpha Vantage. Our standard API rate limit is 25 requests per day.", "data": [option_record(date.today() + timedelta(days=21))]},
    )
    provider = AlphaVantageProvider("alpha-key", StubUnderlyingProvider(), client=client)

    with pytest.raises(ProviderUnavailable) as raised:
        asyncio.run(provider.fetch_chain("XYZ", 7, 45))
    assert raised.value.code == "rate_limited"


def test_alpha_vantage_search_verifies_us_instrument_identity():
    client = FakeAlphaClient(
        {"bestMatches": [
            {"1. symbol": "AAPL", "2. name": "Apple Inc", "3. type": "Equity", "4. region": "United States", "8. currency": "USD"},
            {"1. symbol": "VFIAX", "2. name": "Vanguard 500 Index Fund", "3. type": "Mutual Fund", "4. region": "United States", "8. currency": "USD"},
            {"1. symbol": "VOD.LON", "2. name": "Vodafone", "3. type": "Equity", "4. region": "United Kingdom", "8. currency": "GBP"},
            {"1. symbol": "USD", "2. name": "US Dollar", "3. type": "Currency", "4. region": "United States", "8. currency": "USD"},
        ]},
    )
    provider = AlphaVantageProvider("alpha-key", StubUnderlyingProvider(), client=client)

    result = asyncio.run(provider.search_instruments("Apple"))

    assert result["provider"] == "alphavantage"
    assert result["provider_unofficial"] is False
    assert [item["symbol"] for item in result["matches"]] == ["AAPL", "VFIAX"]
    assert result["matches"][1]["instrument_type"] == "Mutual Fund"
    assert all(item["exchange"] is None for item in result["matches"])
    assert client.calls[0]["function"] == "SYMBOL_SEARCH"


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

    from app.providers import YFinanceProvider
    client = FakeYahooClient()
    provider = YFinanceProvider(search_client=client)

    result = asyncio.run(provider.search_instruments("AAPL", 8))

    assert [item["symbol"] for item in result["matches"]] == ["AAPL"]
    assert client.calls[0][0] == YFinanceProvider.search_url
    assert client.calls[0][1]["q"] == "AAPL"


def test_yfinance_search_rejects_malformed_quotes_without_leaking_type_error():
    class FakeYahooClient:
        async def get(self, _url, params):
            return FakeResponse({"quotes": None})

    from app.providers import YFinanceProvider
    provider = YFinanceProvider(search_client=FakeYahooClient())

    with pytest.raises(ProviderUnavailable) as raised:
        asyncio.run(provider.search_instruments("AAPL"))
    assert raised.value.code == "invalid_response"


class StubProvider:
    def __init__(self, name, result=None, error=None, delay=0):
        self.name = name
        self.result = result
        self.error = error
        self.delay = delay
        self.calls = 0

    async def fetch_chain(self, _symbol, _min_dte, _max_dte):
        self.calls += 1
        await asyncio.sleep(self.delay)
        if self.error:
            raise self.error
        return self.result


def test_provider_chain_marks_yfinance_fallback_as_degraded():
    fallback = ChainSnapshot(provider="yfinance", unofficial=True, underlying_price=100, fetched_at=datetime.now(UTC), quotes=[])
    chain = FallbackProvider([
        StubProvider("alphavantage", error=ProviderUnavailable("alphavantage", "entitlement_required")),
        StubProvider("yfinance", result=fallback),
    ])

    snapshot = asyncio.run(chain.fetch_chain("XYZ", 7, 45))

    assert snapshot is fallback
    assert snapshot.degraded is True
    assert snapshot.warning == "alphavantage real-time options entitlement is required; using yfinance fallback"

    result = asyncio.run(ScreenerService(chain).run(ScreenRequest(
        symbol="XYZ", leg="cash_secured_put", cash_available=10_000,
    )))
    assert result["provider"] == "yfinance"
    assert result["degraded"] is True
    assert result["warning"] == snapshot.warning


def test_provider_chain_rejects_unknown_configuration():
    with pytest.raises(ValueError, match="Unsupported screener provider"):
        build_provider_chain("alphavantage,unknown", "alpha-key")


def test_default_chain_uses_alpha_options_first_and_shared_yahoo_underlying():
    chain = build_provider_chain("alphavantage,yfinance", "alpha-key")

    assert chain.provider_names == ["alphavantage", "yfinance"]
    assert chain.providers[0].underlying_provider is chain.providers[1]


def test_alpha_vantage_falls_back_when_no_contracts_survive_filtering():
    client = FakeAlphaClient(
        {"data": [option_record(datetime.now(UTC).date() + timedelta(days=90))]},
    )
    fallback = StubProvider("yfinance", result=ChainSnapshot(
        provider="yfinance", unofficial=True, underlying_price=100,
        fetched_at=datetime.now(UTC), quotes=[],
    ))
    chain = FallbackProvider([AlphaVantageProvider("alpha-key", StubUnderlyingProvider(), client=client), fallback])

    snapshot = asyncio.run(chain.fetch_chain("XYZ", 7, 45))

    assert snapshot.provider == "yfinance"
    assert snapshot.degraded is True
    assert fallback.calls == 1


def test_provider_chain_reserves_time_for_fallback():
    fallback = StubProvider("yfinance", result=ChainSnapshot(
        provider="yfinance", unofficial=True, underlying_price=100,
        fetched_at=datetime.now(UTC), quotes=[],
    ), delay=0.01)
    chain = FallbackProvider([
        StubProvider("alphavantage", error=ProviderUnavailable("alphavantage", "timeout"), delay=0.04),
        fallback,
    ], timeout_seconds=0.05)

    result = asyncio.run(ScreenerService(chain, timeout_seconds=0.05).run(ScreenRequest(
        symbol="XYZ", leg="cash_secured_put", cash_available=10_000,
    )))

    assert result["provider"] == "yfinance"
    assert result["warning"] == "alphavantage timed out; using yfinance fallback"
    assert fallback.calls == 1
