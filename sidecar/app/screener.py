import asyncio
import math
import time
from datetime import UTC, datetime

from scipy.stats import norm

from .models import ChainSnapshot, ScreenRequest

CALCULATION_VERSION = "screener-2.2.0"


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
    quote_reference_time = snapshot.underlying_quote_time.astimezone(UTC) if snapshot.underlying_quote_time else now
    wanted = "put" if request.leg == "cash_secured_put" else "call"
    candidates, exclusions = [], {}
    for quote in snapshot.quotes:
        if quote.option_type != wanted:
            continue
        reasons = []
        dte = (quote.expiration - now.date()).days
        moneyness = quote.strike / snapshot.underlying_price
        age = math.inf if quote.quote_time is None else max(0, (quote_reference_time - quote.quote_time.astimezone(UTC)).total_seconds())
        if not request.min_dte <= dte <= request.max_dte: reasons.append("dte")
        if not request.min_moneyness <= moneyness <= request.max_moneyness: reasons.append("moneyness")
        if wanted == "put" and quote.strike > snapshot.underlying_price: reasons.append("in_the_money")
        if wanted == "call" and quote.strike < snapshot.underlying_price and not request.allow_itm_calls: reasons.append("in_the_money")
        if quote.bid is None or quote.ask is None or quote.bid <= 0 or quote.ask < quote.bid: reasons.append("invalid_quote")
        midpoint = ((quote.bid or 0) + (quote.ask or 0)) / 2
        spread = ((quote.ask or 0) - (quote.bid or 0)) / midpoint if midpoint > 0 else math.inf
        if spread > request.max_spread_percent: reasons.append("spread")
        if quote.open_interest is None:
            if request.min_open_interest > 0: reasons.append("open_interest_unavailable")
        elif quote.open_interest < request.min_open_interest: reasons.append("open_interest")
        if quote.volume is None:
            if request.min_volume > 0: reasons.append("volume_unavailable")
        elif quote.volume < request.min_volume: reasons.append("volume")
        if age > request.max_quote_age_seconds: reasons.append("stale_quote")
        executable = midpoint if spread <= request.max_spread_percent else (quote.bid or 0)
        gross_credit = round(executable * 100, 2)
        net = round(gross_credit - request.estimated_fee_per_contract, 2)
        net_credit_per_share = net / 100
        net_sale_price = quote.strike + net_credit_per_share if wanted == "call" else None
        net_purchase_price = quote.strike - net_credit_per_share if wanted == "put" else None
        if request.leg == "cash_secured_put":
            denominator = quote.strike * 100 - net
            if quote.strike * 100 > request.cash_available: reasons.append("insufficient_cash")
            if request.max_net_purchase_price is not None and net_purchase_price > request.max_net_purchase_price: reasons.append("max_net_purchase_price")
            basis_yield = None
        else:
            denominator = snapshot.underlying_price * 100
            if request.covered_shares < 100: reasons.append("insufficient_shares")
            if request.min_net_sale_price is not None and net_sale_price < request.min_net_sale_price: reasons.append("min_net_sale_price")
            basis_yield = net / (request.adjusted_basis_per_share * 100) if request.adjusted_basis_per_share else None
        delta, theta = estimated_greeks(wanted, snapshot.underlying_price, quote.strike, dte / 365, quote.implied_volatility, request.risk_free_rate, request.dividend_yield)
        greek_source = "black_scholes_estimate" if delta is not None else "unavailable"
        absolute_delta = abs(delta) if delta is not None else None
        if request.target_delta_min is not None and (absolute_delta is None or absolute_delta < request.target_delta_min): reasons.append("delta_low")
        if request.target_delta_max is not None and (absolute_delta is None or absolute_delta > request.target_delta_max): reasons.append("delta_high")
        period_return = net / denominator if denominator > 0 else 0
        if period_return < request.min_period_return: reasons.append("period_return")
        if reasons:
            for reason in set(reasons): exclusions[reason] = exclusions.get(reason, 0) + 1
            continue
        candidates.append({"contract_symbol": quote.symbol, "option_type": wanted, "expiration": quote.expiration.isoformat(), "dte": dte,
            "strike": quote.strike, "underlying_price": snapshot.underlying_price, "moneyness": moneyness,
            "bid": quote.bid, "ask": quote.ask, "executable_option_price_per_share": executable,
            "executable_premium": executable, "spread_percent": spread,
            "gross_contract_credit": gross_credit, "estimated_fees": request.estimated_fee_per_contract,
            "net_contract_credit": net, "net_premium": net, "period_return": period_return, "annualized_return": period_return * 365 / dte,
            "yield_on_adjusted_basis": basis_yield, "yield_on_market_value": net / (snapshot.underlying_price * 100) if request.leg == "covered_call" else None,
            "breakeven": net_purchase_price if wanted == "put" else (request.adjusted_basis_per_share or snapshot.underlying_price) - net_credit_per_share,
            "downside_buffer": (snapshot.underlying_price - quote.strike) / snapshot.underlying_price,
            "strike_distance": (quote.strike - snapshot.underlying_price) / snapshot.underlying_price,
            "distance_from_strike": (quote.strike - snapshot.underlying_price) / snapshot.underlying_price,
            "net_sale_price": net_sale_price, "net_purchase_price": net_purchase_price,
            "delta": delta, "theta_per_day": theta, "greek_source": greek_source, "volume": quote.volume,
            "implied_volatility": quote.implied_volatility, "open_interest": quote.open_interest,
            "quote_time": quote.quote_time.isoformat(), "quote_age_seconds": age})
    delta_midpoint = None if request.target_delta_min is None or request.target_delta_max is None else (request.target_delta_min + request.target_delta_max) / 2
    dte_midpoint = (request.min_dte + request.max_dte) / 2
    candidates.sort(key=lambda item: (
        item["delta"] is None,
        abs(abs(item["delta"]) - delta_midpoint) if item["delta"] is not None and delta_midpoint is not None else 0,
        abs(item["dte"] - dte_midpoint),
        -item["period_return"],
        item["spread_percent"],
        item["expiration"], item["strike"], item["contract_symbol"],
    ))
    return candidates[:request.limit], exclusions


class ScreenerService:
    def __init__(self, provider, ttl_seconds=120, timeout_seconds=15, max_concurrency=2):
        self.provider, self.ttl, self.timeout = provider, ttl_seconds, timeout_seconds
        self.cache, self.in_flight, self.semaphore = {}, {}, asyncio.Semaphore(max_concurrency)

    async def _fetch(self, symbol, min_dte, max_dte):
        key = (symbol, min_dte, max_dte)
        if key not in self.in_flight:
            async def fetch():
                async with self.semaphore:
                    return await asyncio.wait_for(self.provider.fetch_chain(symbol, min_dte, max_dte), self.timeout)
            self.in_flight[key] = asyncio.create_task(fetch())
        try:
            return await self.in_flight[key]
        finally:
            self.in_flight.pop(key, None)

    async def run(self, request):
        started, now = time.monotonic(), datetime.now(UTC)
        chain_min_dte = request.chain_min_dte or request.min_dte
        chain_max_dte = request.chain_max_dte or request.max_dte
        cache_key = (request.symbol, chain_min_dte, chain_max_dte)
        cached = self.cache.get(cache_key)
        cache_age = (now - cached.fetched_at).total_seconds() if cached else None
        cache_hit = cached is not None and cache_age <= self.ttl
        if cache_hit:
            snapshot = cached
        else:
            snapshot = await self._fetch(request.symbol, chain_min_dte, chain_max_dte)
            self.cache[cache_key] = snapshot
            cache_age = max(0, (now - snapshot.fetched_at).total_seconds())
        candidates, exclusions = screen(snapshot, request, now)
        return {"schema_version": 1, "calculation_version": CALCULATION_VERSION, "symbol": request.symbol, "leg": request.leg,
            "provider": snapshot.provider, "provider_unofficial": snapshot.unofficial, "underlying_price": snapshot.underlying_price,
            "quote_timestamp": snapshot.underlying_quote_time,
            "cache": {"hit": cache_hit, "age_seconds": cache_age},
            "assumptions": {"executable_price": "midpoint only when spread threshold passes; otherwise excluded", "contract_multiplier": 100, "fees": "estimated fee is subtracted from gross contract credit", "annualization": "simple return * 365 / DTE", "put_denominator": "strike collateral less net contract credit", "call_breakeven": "broker cost basis when available, otherwise current underlying price, less net credit per share; never used as a sale-price gate", "risk_free_rate": request.risk_free_rate, "dividend_yield": request.dividend_yield},
            "candidates": candidates, "exclusions": exclusions, "duration_ms": round((time.monotonic() - started) * 1000, 2)}
