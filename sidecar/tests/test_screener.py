from datetime import UTC, date, datetime

from fastapi.testclient import TestClient

from app.main import app
from app.models import ChainSnapshot, OptionQuote, ScreenRequest
from app.screener import estimated_greeks, screen

NOW = datetime(2026, 8, 23, 16, tzinfo=UTC)


def snapshot():
    quote = OptionQuote(symbol="XYZ260918P00095000", option_type="put", expiration=date(2026, 9, 18), strike=95, bid=2, ask=2.10, volume=100, open_interest=500, implied_volatility=.3, quote_time=NOW)
    return ChainSnapshot(provider="fixture", underlying_price=100, fetched_at=NOW, quotes=[quote])


def test_known_put_metrics_and_estimated_greeks():
    candidates, excluded = screen(snapshot(), ScreenRequest(symbol="XYZ", leg="cash_secured_put", cash_available=10000), NOW)
    item = candidates[0]
    assert excluded == {}
    assert item["executable_premium"] == 2.05
    assert round(item["net_premium"], 2) == 204.35
    assert round(item["period_return"], 6) == round(204.35 / 9295.65, 6)
    assert item["greek_source"] == "black_scholes_estimate"
    assert item["delta"] is not None and item["theta_per_day"] < 0


def test_constraints_return_named_exclusions():
    candidates, excluded = screen(snapshot(), ScreenRequest(symbol="XYZ", leg="cash_secured_put", cash_available=1000, min_open_interest=1000), NOW)
    assert candidates == []
    assert excluded == {"open_interest": 1, "insufficient_cash": 1}


def test_invalid_volatility_returns_null_greeks():
    assert estimated_greeks("put", 100, 95, .1, None, .04, 0) == (None, None)


def test_contract_rejects_invalid_bounds_and_oversized_symbol():
    response = TestClient(app).post("/v1/screens", json={"symbol": "TOO-LONG-SYMBOL", "leg": "cash_secured_put", "min_dte": 50, "max_dte": 10})
    assert response.status_code == 422


def test_health_reports_provider_priority():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["providers"] == "alphavantage,yfinance"
