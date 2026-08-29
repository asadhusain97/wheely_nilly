import sys
from pathlib import Path

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from api.market.index import app  # noqa: E402


def test_vercel_rewrite_restores_nested_market_route():
    response = TestClient(app).get("/api/market?route=health")

    assert response.status_code == 200
    assert response.json() == {
        "service": "wheely-nilly-market",
        "status": "ok",
        "provider": "yfinance",
    }
