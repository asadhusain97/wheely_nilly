import asyncio
import math
import time
from datetime import UTC, datetime

from scipy.stats import norm

from .models import ChainSnapshot, ScreenRequest

CALCULATION_VERSION = "screener-1.0.0"


def estimated_greeks(kind, spot, strike, years, volatility, rate, dividend):
    if not volatility or volatility <= 0 or years <= 0 or spot <= 0 or strike <= 0:
        return None, None
    root_t = math.sqrt(years)
    d1 = (math.log(spot / strike) + (rate - dividend + volatility**2 / 2) * years) / (volatility * root_t)
    d2 = d1 - volatility * root_t
    delta = math.exp(-dividend * years) * norm.cdf(d1) if kind == "call" else math.exp(-dividend * years) * (norm.cdf(d1) - 1)
    theta = -(spot * math.exp(-dividend * years) * norm.pdf(d1) * volatility) / (2 * root_t)
    theta += (-rate * strike * math.exp(-rate * years) * norm.cdf(d2) + dividend * spot * math.exp(-dividend * years) * norm.cdf(d1)) if kind == "call" else (rate * strike * math.exp(-rate * years) * norm.cdf(-d2) - dividend * spot * math.exp(-dividend * years) * norm.cdf(-d1))
    return delta, theta / 365


def screen(snapshot: ChainSnapshot, request: ScreenRequest, now=None):
    now = now or datetime.now(UTC)
    wanted = "put" if request.leg == "cash_secured_put" else "call"
    candidates, exclusions = [], {}
    for quote in snapshot.quotes:
        if quote.option_type != wanted:
            continue
        reasons = []
        dte = (quote.expiration - now.date()).days
        moneyness = quote.strike / snapshot.underlying_price
        age = max(0, (now - quote.quote_time.astimezone(UTC)).total_seconds())
        if not request.min_dte <= dte <= request.max_dte: reasons.append("dte")
        if not request.min_moneyness <= moneyness <= request.max_moneyness: reasons.append("moneyness")
        if wanted == "put" and quote.strike > snapshot.underlying_price: reasons.append("in_the_money")
        if wanted == "call" and quote.strike < max(snapshot.underlying_price, request.adjusted_basis_per_share or 0): reasons.append("below_call_floor")
        if quote.bid is None or quote.ask is None or quote.bid <= 0 or quote.ask < quote.bid: reasons.append("invalid_quote")
        midpoint = ((quote.bid or 0) + (quote.ask or 0)) / 2
        spread = ((quote.ask or 0) - (quote.bid or 0)) / midpoint if midpoint > 0 else math.inf
        if spread > request.max_spread_percent: reasons.append("spread")
        if (quote.open_interest or 0) < request.min_open_interest: reasons.append("open_interest")
        if (quote.volume or 0) < request.min_volume: reasons.append("volume")
        if age > request.max_quote_age_seconds: reasons.append("stale_quote")
        executable = midpoint if spread <= request.max_spread_percent else (quote.bid or 0)
        net = executable * 100 - request.estimated_fee_per_contract
        if request.leg == "cash_secured_put":
            denominator = quote.strike * 100 - net
            if quote.strike * 100 > request.cash_available: reasons.append("insufficient_cash")
            basis_yield = None
        else:
            denominator = snapshot.underlying_price * 100
            if request.covered_shares < 100: reasons.append("insufficient_shares")
            basis_yield = net / (request.adjusted_basis_per_share * 100) if request.adjusted_basis_per_share else None
        delta, theta = quote.delta, quote.theta
        greek_source = "provider"
        if delta is None or theta is None:
            delta, theta = estimated_greeks(wanted, snapshot.underlying_price, quote.strike, dte / 365, quote.implied_volatility, request.risk_free_rate, request.dividend_yield)
            greek_source = "black_scholes_estimate" if delta is not None else "unavailable"
        absolute_delta = abs(delta) if delta is not None else None
        if request.target_delta_min is not None and (absolute_delta is None or absolute_delta < request.target_delta_min): reasons.append("delta_low")
        if request.target_delta_max is not None and (absolute_delta is None or absolute_delta > request.target_delta_max): reasons.append("delta_high")
        if reasons:
            for reason in set(reasons): exclusions[reason] = exclusions.get(reason, 0) + 1
            continue
        period_return = net / denominator
        candidates.append({"contract_symbol": quote.symbol, "expiration": quote.expiration.isoformat(), "dte": dte,
            "strike": quote.strike, "underlying_price": snapshot.underlying_price, "moneyness": moneyness,
            "bid": quote.bid, "ask": quote.ask, "executable_premium": executable, "spread_percent": spread,
            "net_premium": net, "period_return": period_return, "annualized_return": period_return * 365 / dte,
            "yield_on_adjusted_basis": basis_yield, "yield_on_market_value": net / (snapshot.underlying_price * 100) if request.leg == "covered_call" else None,
            "breakeven": quote.strike - executable if wanted == "put" else (request.adjusted_basis_per_share or snapshot.underlying_price) - executable,
            "downside_buffer": (snapshot.underlying_price - quote.strike) / snapshot.underlying_price,
            "distance_from_strike": (quote.strike - snapshot.underlying_price) / snapshot.underlying_price,
            "delta": delta, "theta_per_day": theta, "greek_source": greek_source, "volume": quote.volume,
            "open_interest": quote.open_interest, "quote_time": quote.quote_time.isoformat(), "quote_age_seconds": age})
    candidates.sort(key=lambda item: (-item["annualized_return"], item["spread_percent"]))
    return candidates[:request.limit], exclusions


class ScreenerService:
    def __init__(self, provider, ttl_seconds=120, timeout_seconds=15, max_concurrency=2):
        self.provider, self.ttl, self.timeout = provider, ttl_seconds, timeout_seconds
        self.cache, self.semaphore = {}, asyncio.Semaphore(max_concurrency)

    async def run(self, request):
        started, now = time.monotonic(), datetime.now(UTC)
        cache_key = (request.symbol, request.min_dte, request.max_dte)
        cached = self.cache.get(cache_key)
        cache_age = (now - cached.fetched_at).total_seconds() if cached else None
        cache_hit = cached is not None and cache_age <= self.ttl
        degraded = False
        if cache_hit:
            snapshot = cached
        else:
            try:
                async with self.semaphore:
                    snapshot = await asyncio.wait_for(self.provider.fetch_chain(request.symbol, request.min_dte, request.max_dte), self.timeout)
                self.cache[cache_key] = snapshot
                cache_age = max(0, (now - snapshot.fetched_at).total_seconds())
            except Exception as error:
                if not cached: raise
                snapshot, degraded = cached, True
                snapshot.stale, snapshot.warning = True, f"provider unavailable; using stale cache: {type(error).__name__}"
                cache_age = max(0, (now - snapshot.fetched_at).total_seconds())
        candidates, exclusions = screen(snapshot, request, now)
        return {"schema_version": 1, "calculation_version": CALCULATION_VERSION, "symbol": request.symbol, "leg": request.leg,
            "provider": snapshot.provider, "provider_unofficial": snapshot.unofficial, "quote_timestamp": snapshot.fetched_at,
            "cache": {"hit": cache_hit, "age_seconds": cache_age, "stale": snapshot.stale}, "degraded": degraded or snapshot.stale,
            "warning": snapshot.warning, "assumptions": {"executable_price": "midpoint only when spread threshold passes; otherwise excluded", "contract_multiplier": 100, "annualization": "simple return * 365 / DTE", "put_denominator": "strike collateral less net premium", "risk_free_rate": request.risk_free_rate, "dividend_yield": request.dividend_yield},
            "candidates": candidates, "exclusions": exclusions, "duration_ms": round((time.monotonic() - started) * 1000, 2)}
