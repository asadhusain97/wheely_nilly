export interface VercelRequest {
  method?: string;
  url?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | string[] | undefined>;
}

export interface VercelResponse {
  setHeader(name: string, value: string | string[]): this;
  getHeader(name: string): string | number | string[] | undefined;
  status(code: number): this;
  json(value: unknown): this;
  redirect(status: number, url: string): this;
  end(): this;
}
