/**
 * Headers for an API request. The JSON content type goes only on requests that carry a body: the server rejects an
 * empty body labelled application/json (Fastify's FST_ERR_CTP_EMPTY_JSON_BODY), which broke bodyless POST and DELETE.
 */
export function requestHeaders(token: string | null | undefined, options: RequestInit): Record<string, string> {
  return {
    ...(options.body != null ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...((options.headers as Record<string, string>) || {}),
  }
}
