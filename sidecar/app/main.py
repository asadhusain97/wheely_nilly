import os

from fastapi import FastAPI, HTTPException

from .models import ScreenRequest
from .providers import build_provider_chain
from .screener import ScreenerService

app = FastAPI(
    title="Wheel Strategy Screener",
    description="Internal options screening sidecar",
    version="1.0.0",
)
timeout_seconds = float(os.getenv("SCREENER_TIMEOUT_SECONDS", "15"))
provider = build_provider_chain(os.getenv("SCREENER_PROVIDERS", "alphavantage,yfinance"), os.getenv("ALPHAVANTAGE_API_KEY", ""), timeout_seconds=timeout_seconds)
service = ScreenerService(provider, ttl_seconds=int(os.getenv("SCREENER_CACHE_TTL_SECONDS", "120")), timeout_seconds=timeout_seconds, max_concurrency=int(os.getenv("SCREENER_MAX_CONCURRENCY", "2")))


@app.get("/health")
def health() -> dict[str, str]:
    return {"service": "wheel-strategy-screener", "status": "ok", "calculation_version": "screener-1.0.0", "providers": ",".join(provider.provider_names)}


@app.post("/v1/screens")
async def create_screen(request: ScreenRequest):
    try:
        return await service.run(request)
    except Exception as error:
        raise HTTPException(status_code=503, detail={"code": "PROVIDER_UNAVAILABLE", "message": f"Options provider unavailable ({type(error).__name__})"}) from error
