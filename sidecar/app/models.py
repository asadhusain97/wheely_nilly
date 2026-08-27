from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ScreenRequest(BaseModel):
    symbol: str = Field(pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")
    leg: Literal["cash_secured_put", "covered_call"]
    min_dte: int = Field(default=7, ge=1, le=365)
    max_dte: int = Field(default=45, ge=1, le=730)
    min_moneyness: float = Field(default=0.80, gt=0, le=2)
    max_moneyness: float = Field(default=1.20, gt=0, le=3)
    min_open_interest: int = Field(default=10, ge=0)
    min_volume: int = Field(default=0, ge=0)
    max_spread_percent: float = Field(default=0.20, gt=0, le=1)
    target_delta_min: float | None = Field(default=None, ge=0, le=1)
    target_delta_max: float | None = Field(default=0.35, ge=0, le=1)
    cash_available: float = Field(default=0, ge=0)
    covered_shares: int = Field(default=0, ge=0)
    adjusted_basis_per_share: float | None = Field(default=None, gt=0)
    estimated_fee_per_contract: float = Field(default=0.65, ge=0, le=100)
    risk_free_rate: float = Field(default=0.045, ge=-0.1, le=0.5)
    dividend_yield: float = Field(default=0, ge=0, le=0.5)
    max_quote_age_seconds: int = Field(default=900, ge=1, le=86400)
    min_period_return: float = Field(default=0, ge=0, le=10)
    min_net_sale_price: float | None = Field(default=None, ge=0)
    max_net_purchase_price: float | None = Field(default=None, ge=0)
    allow_itm_calls: bool = False
    chain_min_dte: int | None = Field(default=None, ge=1, le=365)
    chain_max_dte: int | None = Field(default=None, ge=1, le=730)
    limit: int = Field(default=20, ge=1, le=100)

    @model_validator(mode="after")
    def validate_ranges(self):
        if self.min_dte > self.max_dte or self.min_moneyness > self.max_moneyness:
            raise ValueError("minimum bounds must not exceed maximum bounds")
        if self.target_delta_min is not None and self.target_delta_max is not None and self.target_delta_min > self.target_delta_max:
            raise ValueError("target_delta_min must not exceed target_delta_max")
        if (self.chain_min_dte is None) != (self.chain_max_dte is None):
            raise ValueError("chain DTE bounds must be supplied together")
        if self.chain_min_dte is not None and (self.chain_min_dte > self.min_dte or self.chain_max_dte < self.max_dte):
            raise ValueError("chain DTE bounds must contain the screening range")
        if self.leg == "covered_call" and self.max_net_purchase_price is not None:
            raise ValueError("max_net_purchase_price applies only to cash-secured puts")
        if self.leg == "cash_secured_put" and (self.min_net_sale_price is not None or self.allow_itm_calls):
            raise ValueError("covered-call controls do not apply to cash-secured puts")
        return self


class OptionQuote(BaseModel):
    symbol: str
    option_type: Literal["put", "call"]
    expiration: date
    strike: float = Field(gt=0)
    bid: float | None = None
    ask: float | None = None
    last: float | None = None
    volume: int | None = None
    open_interest: int | None = None
    implied_volatility: float | None = None
    quote_time: datetime | None = None


class ChainSnapshot(BaseModel):
    provider: str
    unofficial: bool = False
    underlying_price: float = Field(gt=0)
    underlying_quote_time: datetime | None = None
    fetched_at: datetime
    quotes: list[OptionQuote]
