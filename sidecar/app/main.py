from fastapi import FastAPI

app = FastAPI(
    title="Wheel Strategy Screener",
    description="Internal options screening sidecar",
    version="0.1.0",
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"service": "wheel-strategy-screener", "status": "ok"}
