/**
 * HTTP client for the SentinelAI API.
 *
 * Two behaviours worth pointing at, because both exist for a reason rather than out
 * of habit:
 *
 * 1. The bearer token is cached and refreshed on a 401. Producers are long-lived
 *    and the token expires; without the refresh the first event after expiry would
 *    fail and every subsequent one would too, which looks like a backend outage.
 *
 * 2. Retries are bounded and only cover transport failures and 5xx. A 4xx is the
 *    server telling us the payload is wrong, and resending an identical wrong payload
 *    is how a producer turns one bad event into a hundred.
 */

const TOKEN_SAFETY_MARGIN_MS = 30_000;

export class ApiError extends Error {
  constructor(status, body, path) {
    const code = body && typeof body === 'object' ? body.code : undefined;
    const message = body && typeof body === 'object' ? body.message : undefined;
    super(`POST ${path} -> ${status}${code ? ` ${code}` : ''}: ${message ?? 'no message'}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? 'UNKNOWN';
    this.body = body;
  }
}

export class SentinelClient {
  #baseUrl;
  #email;
  #password;
  #token = null;
  #expiresAt = 0;
  #inflightLogin = null;

  constructor({ baseUrl, email, password }) {
    this.#baseUrl = baseUrl;
    this.#email = email;
    this.#password = password;
  }

  async login() {
    const response = await fetch(`${this.#baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: this.#email, password: this.#password }),
    });
    if (!response.ok) {
      const body = await safeJson(response);
      throw new ApiError(response.status, body, '/api/v1/auth/login');
    }
    const payload = await response.json();
    this.#token = payload.accessToken;
    this.#expiresAt = Date.parse(payload.expiresAt) - TOKEN_SAFETY_MARGIN_MS;
    return payload.user;
  }

  /** Returns the cached token, logging in if there is none or it is about to expire. */
  async accessToken() {
    if (this.#token && Date.now() < this.#expiresAt) {
      return this.#token;
    }
    // Several concurrent requests can notice an expired token at once. Without this
    // they would each perform a login, and the extra ones would look like a burst.
    if (!this.#inflightLogin) {
      this.#inflightLogin = this.login().finally(() => {
        this.#inflightLogin = null;
      });
    }
    await this.#inflightLogin;
    return this.#token;
  }

  /**
   * Ingests one event, retrying transport failures and 5xx with capped backoff.
   *
   * @param {object} event       the event as the producer would emit it
   * @param {object} [options]
   * @param {number} [options.retries] attempts after the first
   * @returns {Promise<{status:number, body:object, attempts:number, duplicate:boolean}>}
   */
  async ingestEvent(event, { retries = 3 } = {}) {
    const path = '/api/v1/events';
    let lastError;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const token = await this.accessToken();
        const response = await fetch(`${this.#baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            // The idempotency namespace. The server prefers this header over the
            // body field, so scoping it here means two simulators pointed at one
            // backend cannot collide on a generated id.
            'X-Sentinel-Source': event.sourceScope,
          },
          body: JSON.stringify(event),
        });

        const body = await safeJson(response);
        if (response.status === 401 && attempt <= retries) {
          this.#token = null;
          lastError = new ApiError(401, body, path);
          continue;
        }
        if (response.status >= 500 && attempt <= retries) {
          lastError = new ApiError(response.status, body, path);
          await sleep(backoff(attempt));
          continue;
        }
        if (!response.ok) {
          // 4xx is final. Resending it wastes the producer's time and, on some
          // endpoints, the server's patience.
          throw new ApiError(response.status, body, path);
        }
        return {
          status: response.status,
          body,
          attempts: attempt,
          duplicate: body?.duplicate === true,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof ApiError && error.status < 500) {
          throw error;
        }
        if (attempt > retries) {
          break;
        }
        await sleep(backoff(attempt));
      }
    }
    throw lastError ?? new Error('ingestion failed for an unknown reason');
  }

  /** Convenience for the summary: how many incidents currently look active. */
  async countOpenIncidents() {
    const token = await this.accessToken();
    const response = await fetch(`${this.#baseUrl}/api/v1/incidents?activeOnly=true&size=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new ApiError(response.status, await safeJson(response), '/api/v1/incidents');
    }
    const body = await response.json();
    return body?.totalElements ?? 0;
  }
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

function backoff(attempt) {
  const millis = Math.min(2000, 100 * 2 ** (attempt - 1));
  // Full jitter: a fleet of producers that all back off in lockstep would resend
  // together, which is the traffic shape the backoff exists to avoid.
  return sleep(Math.floor(Math.random() * millis));
}

export function sleep(millis) {
  return new Promise((resolve) => setTimeout(resolve, millis));
}