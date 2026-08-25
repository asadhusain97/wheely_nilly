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
    def __init__(self, options, quote):
        self.options = options
        self.quote = quote
        self.calls = []

    async def get(self, _url, params):
        self.calls.append(params)
        await asyncio.sleep(0)
        return FakeResponse(self.options if params["function"] == "REALTIME_OPTIONS" else self.quote)


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


def test_alpha_vantage_fetches_realtime_chain_and_spot_concurrently():
    expiration = datetime.now(UTC).date() + timedelta(days=21)
    client = FakeAlphaClient(
        {"data": [option_record(expiration)]},
        {"Global Quote": {"05. price": "101.25"}},
    )
    provider = AlphaVantageProvider("alpha-key", client=client)

    snapshot = asyncio.run(provider.fetch_chain("XYZ", 7, 45))

    assert snapshot.provider == "alphavantage"
    assert snapshot.unofficial is False
    assert snapshot.underlying_price == 101.25
    assert len(snapshot.quotes) == 1
    assert snapshot.quotes[0].delta == -0.28
    assert {call["function"] for call in client.calls} == {"REALTIME_OPTIONS", "GLOBAL_QUOTE"}
    assert next(call for call in client.calls if call["function"] == "REALTIME_OPTIONS")["require_greeks"] == "true"
    assert next(call for call in client.calls if call["function"] == "GLOBAL_QUOTE")["entitlement"] == "realtime"


def test_alpha_vantage_classifies_limits_without_using_sample_data():
    client = FakeAlphaClient(
        {"Note": "Thank you for using Alpha Vantage. Our standard API rate limit is 25 requests per day.", "data": [option_record(date.today() + timedelta(days=21))]},
        {"Global Quote": {"05. price": "101.25"}},
    )
    provider = AlphaVantageProvider("alpha-key", client=client)

    with pytest.raises(ProviderUnavailable) as raised:
        asyncio.run(provider.fetch_chain("XYZ", 7, 45))
    assert raised.value.code == "rate_limited"


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


def test_alpha_vantage_falls_back_when_no_contracts_survive_filtering():
    client = FakeAlphaClient(
        {"data": [option_record(datetime.now(UTC).date() + timedelta(days=90))]},
        {"Global Quote": {"05. price": "101.25"}},
    )
    fallback = StubProvider("yfinance", result=ChainSnapshot(
        provider="yfinance", unofficial=True, underlying_price=100,
        fetched_at=datetime.now(UTC), quotes=[],
    ))
    chain = FallbackProvider([AlphaVantageProvider("alpha-key", client=client), fallback])

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
