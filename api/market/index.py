import os
from datetime import UTC, date, datetime

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from sidecar.app.models import ExactContractsRequest, ScreenRequest
from sidecar.app.providers import MarketDataProvider, ProviderUnavailable
from sidecar.app.screener import ScreenerService


class QuotesRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=50)


class ChainRequest(BaseModel):
    symbol: str = Field(pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")
    expiration: date


app = FastAPI(title="Wheely Nilly market API", version="1.0.0")
timeout_seconds = float(os.getenv("MARKET_TIMEOUT_SECONDS", "15"))
provider = MarketDataProvider(timeout_seconds=timeout_seconds)
service = ScreenerService(provider, ttl_seconds=120, timeout_seconds=timeout_seconds, max_concurrency=2)


@app.get("/api/market/health")
def health():
    return {"service": "wheely-nilly-market", "status": "ok", "provider": provider.name}


@app.post("/api/market/quotes")
async def quotes(request: QuotesRequest):
    symbols = []
    for raw in request.symbols:
        symbol = raw.strip().upper()
        if not symbol or not symbol[0].isalpha() or len(symbol) > 10:
            raise HTTPException(status_code=400, detail={"code": "INVALID_SYMBOL", "message": "A symbol is invalid"})
        if symbol not in symbols:
            symbols.append(symbol)
    return {"quotes": await provider.fetch_quotes(symbols), "fetched_at": datetime.now(UTC)}


@app.get("/api/market/expirations")
async def expirations(ticker: str = Query(pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")):
    try:
        return {"symbol": ticker, "expirations": await provider.available_expirations(ticker)}
    except Exception as error:
        raise HTTPException(status_code=503, detail={"code": "PROVIDER_UNAVAILABLE", "message": f"Expirations unavailable ({type(error).__name__})"}) from error


@app.post("/api/market/chains")
async def chain(request: ChainRequest):
    dte = (request.expiration - datetime.now(UTC).date()).days
    if dte < 0 or dte > 730:
        raise HTTPException(status_code=400, detail={"code": "INVALID_EXPIRATION", "message": "Expiration must be within 730 days"})
    try:
        return await provider.fetch_chain(request.symbol, dte, dte)
    except ProviderUnavailable as error:
        raise HTTPException(status_code=503, detail={"code": "PROVIDER_UNAVAILABLE", "message": str(error)}) from error


@app.post("/api/market/contracts")
async def contracts(request: ExactContractsRequest):
    return await service.quote_contracts(request)


@app.post("/api/market/screens")
async def screens(request: ScreenRequest):
    try:
        return await service.run(request)
    except ProviderUnavailable as error:
        raise HTTPException(status_code=503, detail={"code": "PROVIDER_UNAVAILABLE", "message": str(error)}) from error


@app.get("/api/market/instruments")
async def instruments(query: str = Query(min_length=1, max_length=50, pattern=r"^[A-Za-z0-9 .&'-]+$")):
    try:
        return await provider.search_instruments(query.strip(), 8)
    except ProviderUnavailable as error:
        raise HTTPException(status_code=503, detail={"code": "PROVIDER_UNAVAILABLE", "message": str(error)}) from error
