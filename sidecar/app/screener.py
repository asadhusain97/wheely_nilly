import asyncio
import math
import time
from datetime import UTC, datetime

from .models import ChainSnapshot, ExactContractsRequest, RollRequest, ScreenRequest

CALCULATION_VERSION = "screener-2.2.0"


def _normal_cdf(value: float) -> float:
    return 0.5 * (1 + math.erf(value / math.sqrt(2)))


def _normal_pdf(value: float) -> float:
    return math.exp(-(value * value) / 2) / math.sqrt(2 * math.pi)


def estimated_greeks(kind, spot, strike, years, volatility, rate, dividend):
    if not volatility or volatility <= 0 or years <= 0 or spot <= 0 or strike <= 0:
        return None, None
    root_t = math.sqrt(years)
    d1 = (math.log(spot / strike) + (rate - dividend + volatility**2 / 2) * years) / (volatility * root_t)
    d2 = d1 - volatility * root_t
    delta = math.exp(-dividend * years) * _normal_cdf(d1) if kind == "call" else math.exp(-dividend * years) * (_normal_cdf(d1) - 1)
    theta = -(spot * math.exp(-dividend * years) * _normal_pdf(d1) * volatility) / (2 * root_t)
    theta += (-rate * strike * math.exp(-rate * years) * _normal_cdf(d2) + dividend * spot * math.exp(-dividend * years) * _normal_cdf(d1)) if kind == "call" else (rate * strike * math.exp(-rate * years) * _normal_cdf(-d2) - dividend * spot * math.exp(-dividend * years) * _normal_cdf(-d1))
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


def chain_has_usable_quotes(snapshot: ChainSnapshot, request: ScreenRequest, now: datetime):
    wanted = "put" if request.leg == "cash_secured_put" else "call"
    quote_reference_time = snapshot.underlying_quote_time.astimezone(UTC) if snapshot.underlying_quote_time else now
    relevant = 0
    for quote in snapshot.quotes:
        dte = (quote.expiration - now.date()).days
        if quote.option_type != wanted or not request.min_dte <= dte <= request.max_dte:
            continue
        relevant += 1
        age = math.inf if quote.quote_time is None else max(0, (quote_reference_time - quote.quote_time.astimezone(UTC)).total_seconds())
        if quote.bid is not None and quote.ask is not None and quote.bid > 0 and quote.ask >= quote.bid and age <= request.max_quote_age_seconds:
            return True
    return relevant == 0


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

    async def _snapshot(self, symbol, min_dte, max_dte, now):
        cache_key = (symbol, min_dte, max_dte)
        cached = self.cache.get(cache_key)
        cache_age = (now - cached.fetched_at).total_seconds() if cached else None
        cache_hit = cached is not None and cache_age <= self.ttl
        if cache_hit:
            return cached, True, cache_age
        snapshot = await self._fetch(symbol, min_dte, max_dte)
        self.cache[cache_key] = snapshot
        return snapshot, False, max(0, (now - snapshot.fetched_at).total_seconds())

    async def run(self, request):
        started, now = time.monotonic(), datetime.now(UTC)
        chain_min_dte = request.chain_min_dte or request.min_dte
        chain_max_dte = request.chain_max_dte or request.max_dte
        snapshot, cache_hit, cache_age = await self._snapshot(request.symbol, chain_min_dte, chain_max_dte, now)
        if not chain_has_usable_quotes(snapshot, request, now):
            raise RuntimeError("option chain has no usable quotes")
        candidates, exclusions = screen(snapshot, request, now)
        return {"schema_version": 1, "calculation_version": CALCULATION_VERSION, "symbol": request.symbol, "leg": request.leg,
            "provider": snapshot.provider, "provider_unofficial": snapshot.unofficial, "underlying_price": snapshot.underlying_price,
            "quote_timestamp": snapshot.underlying_quote_time,
            "cache": {"hit": cache_hit, "age_seconds": cache_age},
            "assumptions": {"executable_price": "midpoint only when spread threshold passes; otherwise excluded", "contract_multiplier": 100, "fees": "estimated fee is subtracted from gross contract credit", "annualization": "simple return * 365 / DTE", "put_denominator": "strike collateral less net contract credit", "call_breakeven": "broker cost basis when available, otherwise current underlying price, less net credit per share; never used as a sale-price gate", "risk_free_rate": request.risk_free_rate, "dividend_yield": request.dividend_yield},
            "candidates": candidates, "exclusions": exclusions, "duration_ms": round((time.monotonic() - started) * 1000, 2)}

    async def roll(self, request: RollRequest):
        started, now = time.monotonic(), datetime.now(UTC)
        current = request.current_contract
        current_dte = max(0, (current.expiration - now.date()).days)
        snapshot, cache_hit, cache_age = await self._snapshot(
            current.symbol, min(current_dte, request.min_dte), max(current_dte, request.max_dte), now,
        )
        current_quote = next((quote for quote in snapshot.quotes
            if quote.symbol.replace(" ", "").upper() == current.contract_symbol.replace(" ", "").upper()), None)
        quote_reference_time = snapshot.underlying_quote_time.astimezone(UTC) if snapshot.underlying_quote_time else now
        current_quote_age = math.inf if current_quote is None or current_quote.quote_time is None else max(
            0, (quote_reference_time - current_quote.quote_time.astimezone(UTC)).total_seconds(),
        )
        current_payload = {
            "available": current_quote is not None and current_quote.ask is not None and current_quote.ask > 0
                and (current_quote.bid is None or current_quote.ask >= current_quote.bid)
                and current_quote_age <= request.max_quote_age_seconds,
            "contract_symbol": current.contract_symbol,
            "bid": current_quote.bid if current_quote else None,
            "ask": current_quote.ask if current_quote else None,
            "quote_time": current_quote.quote_time if current_quote else None,
            "quote_age_seconds": None if math.isinf(current_quote_age) else current_quote_age,
        }
        if current_quote is None:
            current_payload["unavailable_reason"] = "exact current contract quote not found"
        elif current_quote_age > request.max_quote_age_seconds:
            current_payload["unavailable_reason"] = "exact current contract quote is stale"
        elif not current_payload["available"]:
            current_payload["unavailable_reason"] = "exact current contract has no usable ask"
        leg = "covered_call" if current.option_type == "call" else "cash_secured_put"
        candidate_request = ScreenRequest(
            symbol=current.symbol, leg=leg, min_dte=request.min_dte, max_dte=request.max_dte,
            min_moneyness=request.min_moneyness, max_moneyness=request.max_moneyness,
            min_open_interest=request.min_open_interest, min_volume=request.min_volume,
            max_spread_percent=request.max_spread_percent, target_delta_min=request.target_delta_min,
            target_delta_max=request.target_delta_max, cash_available=1_000_000_000,
            covered_shares=1_000_000, estimated_fee_per_contract=request.estimated_fee_per_contract,
            risk_free_rate=request.risk_free_rate, dividend_yield=request.dividend_yield,
            max_quote_age_seconds=request.max_quote_age_seconds, min_period_return=request.min_period_return,
            allow_itm_calls=request.allow_itm_calls, limit=100,
        )
        later_snapshot = snapshot.model_copy(update={"quotes": [
            quote for quote in snapshot.quotes
            if quote.symbol.replace(" ", "").upper() != current.contract_symbol.replace(" ", "").upper()
            and quote.expiration > current.expiration
        ]})
        candidates, exclusions = screen(later_snapshot, candidate_request, now)
        candidates = candidates[:request.limit]
        return {
            "schema_version": 1,
            "calculation_version": CALCULATION_VERSION,
            "symbol": current.symbol,
            "leg": leg,
            "provider": snapshot.provider,
            "provider_unofficial": snapshot.unofficial,
            "underlying_price": snapshot.underlying_price,
            "quote_timestamp": snapshot.underlying_quote_time,
            "fetched_at": snapshot.fetched_at,
            "cache": {"hit": cache_hit, "age_seconds": cache_age},
            "current_quote": current_payload,
            "candidates": candidates,
            "exclusions": exclusions,
            "duration_ms": round((time.monotonic() - started) * 1000, 2),
        }

    async def quote_contracts(self, request: ExactContractsRequest):
        started, now = time.monotonic(), datetime.now(UTC)
        grouped = {}
        for contract in request.contracts:
            grouped.setdefault(contract.symbol, []).append(contract)
        async def quote_group(symbol, contracts):
            group_results = []
            dtes = [(contract.expiration - now.date()).days for contract in contracts]
            try:
                snapshot, cache_hit, cache_age = await self._snapshot(symbol, min(dtes), max(dtes), now)
            except Exception as error:
                for contract in contracts:
                    group_results.append({
                        "contract": contract.model_dump(mode="json"),
                        "available": False,
                        "unavailable_reason": f"provider unavailable ({type(error).__name__})",
                    })
                return group_results
            quotes = {quote.symbol.replace(" ", "").upper(): quote for quote in snapshot.quotes}
            for contract in contracts:
                quote = quotes.get(contract.contract_symbol.replace(" ", "").upper())
                if quote is None:
                    group_results.append({
                        "contract": contract.model_dump(mode="json"),
                        "available": False,
                        "unavailable_reason": "exact contract quote not found",
                        "provider": snapshot.provider,
                        "underlying_price": snapshot.underlying_price,
                        "underlying_quote_time": snapshot.underlying_quote_time,
                        "fetched_at": snapshot.fetched_at,
                        "cache": {"hit": cache_hit, "age_seconds": cache_age},
                    })
                    continue
                if quote.ask is None or quote.ask <= 0 or (quote.bid is not None and quote.ask < quote.bid):
                    group_results.append({
                        "contract": contract.model_dump(mode="json"),
                        "available": False,
                        "unavailable_reason": "exact contract has no usable ask",
                        "provider": snapshot.provider,
                        "underlying_price": snapshot.underlying_price,
                        "underlying_quote_time": snapshot.underlying_quote_time,
                        "contract_quote_time": quote.quote_time,
                        "fetched_at": snapshot.fetched_at,
                        "cache": {"hit": cache_hit, "age_seconds": cache_age},
                    })
                    continue
                dte = (contract.expiration - now.date()).days
                delta, theta = estimated_greeks(
                    contract.option_type, snapshot.underlying_price, contract.strike,
                    max(dte, 0) / 365, quote.implied_volatility,
                    request.risk_free_rate, request.dividend_yield,
                )
                group_results.append({
                    "contract": contract.model_dump(mode="json"),
                    "available": True,
                    "unavailable_reason": None,
                    "provider": snapshot.provider,
                    "provider_unofficial": snapshot.unofficial,
                    "bid": quote.bid,
                    "ask": quote.ask,
                    "underlying_price": snapshot.underlying_price,
                    "strike": quote.strike,
                    "expiration": quote.expiration,
                    "option_type": quote.option_type,
                    "volume": quote.volume,
                    "open_interest": quote.open_interest,
                    "implied_volatility": quote.implied_volatility,
                    "delta": delta,
                    "theta_per_day": theta,
                    "contract_quote_time": quote.quote_time,
                    "underlying_quote_time": snapshot.underlying_quote_time,
                    "fetched_at": snapshot.fetched_at,
                    "cache": {"hit": cache_hit, "age_seconds": cache_age},
                })
            return group_results

        batches = await asyncio.gather(*(
            quote_group(symbol, contracts) for symbol, contracts in grouped.items()
        ))
        results = [item for batch in batches for item in batch]
        order = {contract.contract_symbol: index for index, contract in enumerate(request.contracts)}
        results.sort(key=lambda item: order[item["contract"]["contract_symbol"]])
        return {
            "schema_version": 1,
            "calculation_version": CALCULATION_VERSION,
            "scanned_at": now,
            "results": results,
            "duration_ms": round((time.monotonic() - started) * 1000, 2),
        }
