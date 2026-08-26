import asyncio
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models import ChainSnapshot, OptionQuote, ScreenRequest
from app.screener import ScreenerService, estimated_greeks, screen

NOW = datetime(2026, 8, 23, 16, tzinfo=UTC)


def snapshot():
    quote = OptionQuote(symbol="XYZ260918P00095000", option_type="put", expiration=date(2026, 9, 18), strike=95, bid=2, ask=2.10, volume=100, open_interest=500, implied_volatility=.3, quote_time=NOW)
    return ChainSnapshot(provider="fixture", underlying_price=100, fetched_at=NOW, quotes=[quote])


def test_known_put_metrics_and_estimated_greeks():
    candidates, excluded = screen(snapshot(), ScreenRequest(symbol="XYZ", leg="cash_secured_put", cash_available=10000), NOW)
    item = candidates[0]
    assert excluded == {}
    assert item["executable_premium"] == 2.05
    assert item["gross_contract_credit"] == 205
    assert round(item["net_premium"], 2) == 204.35
    assert round(item["net_contract_credit"], 2) == 204.35
    assert round(item["net_purchase_price"], 4) == 92.9565
    assert round(item["period_return"], 6) == round(204.35 / 9295.65, 6)
    assert item["greek_source"] == "black_scholes_estimate"
    assert item["delta"] is not None and item["theta_per_day"] < 0


def test_constraints_return_named_exclusions():
    candidates, excluded = screen(snapshot(), ScreenRequest(symbol="XYZ", leg="cash_secured_put", cash_available=1000, min_open_interest=1000), NOW)
    assert candidates == []
    assert excluded == {"open_interest": 1, "insufficient_cash": 1}


def test_missing_liquidity_is_not_reported_as_zero():
    quote = OptionQuote(symbol="XYZ260918P00095000", option_type="put", expiration=date(2026, 9, 18),
                        strike=95, bid=2, ask=2.1, volume=None, open_interest=None, quote_time=NOW)
    chain = ChainSnapshot(provider="fixture", underlying_price=100, fetched_at=NOW, quotes=[quote])

    candidates, excluded = screen(chain, ScreenRequest(
        symbol="XYZ", leg="cash_secured_put", cash_available=10_000,
        min_open_interest=10, min_volume=1, target_delta_max=None,
    ), NOW)

    assert candidates == []
    assert excluded == {"open_interest_unavailable": 1, "volume_unavailable": 1}


def test_missing_liquidity_can_pass_disabled_minimums():
    quote = OptionQuote(symbol="XYZ260918P00095000", option_type="put", expiration=date(2026, 9, 18),
                        strike=95, bid=2, ask=2.1, volume=None, open_interest=None, quote_time=NOW)
    chain = ChainSnapshot(provider="fixture", underlying_price=100, fetched_at=NOW, quotes=[quote])

    candidates, excluded = screen(chain, ScreenRequest(
        symbol="XYZ", leg="cash_secured_put", cash_available=10_000,
        min_open_interest=0, min_volume=0, target_delta_max=None,
    ), NOW)

    assert excluded == {}
    assert candidates[0]["open_interest"] is None
    assert candidates[0]["volume"] is None


def test_old_or_missing_yahoo_trade_time_is_stale():
    old_quote = snapshot().quotes[0].model_copy(update={"quote_time": NOW - timedelta(seconds=901)})
    missing_time = snapshot().quotes[0].model_copy(update={"quote_time": None})
    request = ScreenRequest(symbol="XYZ", leg="cash_secured_put", cash_available=10_000)

    old_candidates, old_excluded = screen(
        snapshot().model_copy(update={"quotes": [old_quote]}), request, NOW,
    )
    missing_candidates, missing_excluded = screen(
        snapshot().model_copy(update={"quotes": [missing_time]}), request, NOW,
    )

    assert old_candidates == []
    assert old_excluded == {"stale_quote": 1}
    assert missing_candidates == []
    assert missing_excluded == {"stale_quote": 1}


def test_response_quote_timestamp_comes_from_the_option_trade():
    trade_time = datetime.now(UTC) - timedelta(minutes=5)

    class StaticProvider:
        async def fetch_chain(self, _symbol, _min_dte, _max_dte):
            return snapshot().model_copy(update={
                "fetched_at": datetime.now(UTC),
                "quotes": [snapshot().quotes[0].model_copy(update={"quote_time": trade_time})],
            })

    result = asyncio.run(ScreenerService(StaticProvider()).run(ScreenRequest(
        symbol="XYZ", leg="cash_secured_put", cash_available=10_000,
    )))

    assert result["quote_timestamp"] == trade_time


def test_expired_cache_is_not_used_when_yahoo_fails():
    class FailingProvider:
        async def fetch_chain(self, _symbol, _min_dte, _max_dte):
            raise RuntimeError("Yahoo unavailable")

    service = ScreenerService(FailingProvider(), ttl_seconds=1)
    service.cache[("XYZ", 7, 45)] = snapshot()

    with pytest.raises(RuntimeError, match="Yahoo unavailable"):
        asyncio.run(service.run(ScreenRequest(
            symbol="XYZ", leg="cash_secured_put", cash_available=10_000,
        )))


def test_invalid_volatility_returns_null_greeks():
    assert estimated_greeks("put", 100, 95, .1, None, .04, 0) == (None, None)


def test_contract_rejects_invalid_bounds_and_oversized_symbol():
    response = TestClient(app).post("/v1/screens", json={"symbol": "TOO-LONG-SYMBOL", "leg": "cash_secured_put", "min_dte": 50, "max_dte": 10})
    assert response.status_code == 422


def test_health_reports_yfinance_provider():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["provider"] == "yfinance"


def test_instrument_lookup_rejects_untrusted_query_characters_before_provider_call():
    response = TestClient(app).get("/v1/instruments", params={"query": "<script>"})
    assert response.status_code == 422


def test_period_return_and_net_purchase_price_are_hard_gates_after_fees():
    request = ScreenRequest(symbol="XYZ", leg="cash_secured_put", cash_available=10000,
                            estimated_fee_per_contract=5, min_period_return=.022,
                            max_net_purchase_price=92.95)
    candidates, excluded = screen(snapshot(), request, NOW)
    assert candidates == []
    assert excluded == {"max_net_purchase_price": 1, "period_return": 1}


def test_covered_call_uses_explicit_net_sale_guard_and_exit_can_consider_itm():
    quote = OptionQuote(symbol="XYZ260918C00095000", option_type="call", expiration=date(2026, 9, 18),
                        strike=95, bid=6, ask=6.10, volume=100, open_interest=500,
                        implied_volatility=.3, quote_time=NOW)
    calls = ChainSnapshot(provider="fixture", underlying_price=100, fetched_at=NOW, quotes=[quote])
    ordinary, ordinary_excluded = screen(calls, ScreenRequest(
        symbol="XYZ", leg="covered_call", covered_shares=100, adjusted_basis_per_share=80,
        target_delta_max=1,
    ), NOW)
    assert ordinary == []
    assert ordinary_excluded == {"in_the_money": 1}

    exit_candidates, _ = screen(calls, ScreenRequest(
        symbol="XYZ", leg="covered_call", covered_shares=100, adjusted_basis_per_share=120,
        target_delta_max=1, allow_itm_calls=True, min_net_sale_price=101,
    ), NOW)
    assert round(exit_candidates[0]["net_sale_price"], 4) == 101.0435

    rejected, excluded = screen(calls, ScreenRequest(
        symbol="XYZ", leg="covered_call", covered_shares=100, target_delta_max=1,
        allow_itm_calls=True, min_net_sale_price=101.05,
    ), NOW)
    assert rejected == []
    assert excluded == {"min_net_sale_price": 1}


def test_ranking_is_deterministic_and_prefers_delta_then_dte_then_period_return():
    quotes = [
        OptionQuote(symbol="NO-DELTA", option_type="put", expiration=date(2026, 9, 18), strike=95, bid=2, ask=2.1,
                    volume=10, open_interest=10, quote_time=NOW),
        OptionQuote(symbol="FAR-DTE", option_type="put", expiration=date(2026, 9, 27), strike=95, bid=3, ask=3.1,
                    volume=10, open_interest=10, implied_volatility=.3, quote_time=NOW),
        OptionQuote(symbol="MID-DTE", option_type="put", expiration=date(2026, 9, 18), strike=95, bid=2, ask=2.1,
                    volume=10, open_interest=10, implied_volatility=.3, quote_time=NOW),
    ]
    result, _ = screen(ChainSnapshot(provider="fixture", underlying_price=100, fetched_at=NOW, quotes=quotes), ScreenRequest(
        symbol="XYZ", leg="cash_secured_put", cash_available=10000, min_dte=20, max_dte=50,
        target_delta_min=None, target_delta_max=None, max_spread_percent=.2,
    ), NOW)
    assert [item["contract_symbol"] for item in result] == ["FAR-DTE", "MID-DTE", "NO-DELTA"]


def test_share_coverage_and_missing_greeks_are_explicit():
    quote = OptionQuote(symbol="XYZ260918C00105000", option_type="call", expiration=date(2026, 9, 18), strike=105,
                        bid=1, ask=1.1, volume=100, open_interest=500, quote_time=NOW)
    calls = ChainSnapshot(provider="fixture", underlying_price=100, fetched_at=NOW, quotes=[quote])
    missing_shares, excluded = screen(calls, ScreenRequest(
        symbol="XYZ", leg="covered_call", covered_shares=0, target_delta_min=None, target_delta_max=None,
    ), NOW)
    assert missing_shares == []
    assert excluded == {"insufficient_shares": 1}
    candidates, _ = screen(calls, ScreenRequest(
        symbol="XYZ", leg="covered_call", covered_shares=100, target_delta_min=None, target_delta_max=None,
    ), NOW)
    assert candidates[0]["delta"] is None
    assert candidates[0]["greek_source"] == "unavailable"


def test_matching_chain_ranges_share_one_concurrent_provider_fetch():
    class CountingProvider:
        def __init__(self):
            self.calls = 0

        async def fetch_chain(self, _symbol, _min_dte, _max_dte):
            self.calls += 1
            await asyncio.sleep(.01)
            return ChainSnapshot(provider="fixture", underlying_price=100, fetched_at=NOW, quotes=[])

    async def run_both():
        provider = CountingProvider()
        service = ScreenerService(provider)
        common = {"symbol": "XYZ", "cash_available": 10_000, "chain_min_dte": 7, "chain_max_dte": 45}
        await asyncio.gather(
            service.run(ScreenRequest(leg="cash_secured_put", min_dte=7, max_dte=21, **common)),
            service.run(ScreenRequest(leg="covered_call", covered_shares=100, min_dte=22, max_dte=45, **common)),
        )
        return provider.calls

    assert asyncio.run(run_both()) == 1
