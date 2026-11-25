declare module "cloudflare:test" {
  export const SELF: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  export const env: { DB: D1Database; AUTH_TOKEN: string };
}
