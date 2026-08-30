import os

from fastapi import FastAPI, HTTPException, Query

from .models import ExactContractsRequest, RollRequest, ScreenRequest
from .providers import MarketDataProvider
from .screener import CALCULATION_VERSION, ScreenerService

app = FastAPI(
    title="Wheel Strategy Screener",
    description="Internal options screening sidecar",
    version="1.0.0",
)
timeout_seconds = float(os.getenv("SCREENER_TIMEOUT_SECONDS", "15"))
provider = MarketDataProvider(timeout_seconds=timeout_seconds)
service = ScreenerService(provider, ttl_seconds=int(os.getenv("SCREENER_CACHE_TTL_SECONDS", "120")), timeout_seconds=timeout_seconds, max_concurrency=int(os.getenv("SCREENER_MAX_CONCURRENCY", "2")))


@app.get("/health")
def health() -> dict[str, str]:
    return {"service": "wheel-strategy-screener", "status": "ok", "calculation_version": CALCULATION_VERSION, "provider": provider.name}


@app.get("/v1/instruments")
async def search_instruments(query: str = Query(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9 .&'-]+$")):
    try:
        return await provider.search_instruments(query.strip(), 8)
    except Exception as error:
        raise HTTPException(status_code=503, detail={"code": "PROVIDER_UNAVAILABLE", "message": f"Instrument lookup unavailable ({type(error).__name__})"}) from error


@app.post("/v1/screens")
async def create_screen(request: ScreenRequest):
    try:
        return await service.run(request)
    except Exception as error:
        raise HTTPException(status_code=503, detail={"code": "PROVIDER_UNAVAILABLE", "message": f"Options provider unavailable ({type(error).__name__})"}) from error


@app.post("/v1/contracts/quotes")
async def quote_exact_contracts(request: ExactContractsRequest):
    return await service.quote_contracts(request)


@app.post("/v1/rolls")
async def find_rolls(request: RollRequest):
    try:
        return await service.roll(request)
    except Exception as error:
        raise HTTPException(status_code=503, detail={"code": "PROVIDER_UNAVAILABLE", "message": f"Roll quotes unavailable ({type(error).__name__})"}) from error
