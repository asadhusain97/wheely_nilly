export const mockBrokerageEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const requested = env.BROKERAGE_MODE?.trim().toLowerCase() === "mock";
  const local = env.VERCEL_ENV
    ? env.VERCEL_ENV === "development"
    : env.NODE_ENV !== "production";
  return requested && local;
};
