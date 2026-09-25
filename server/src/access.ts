/**
 * Who may call the API.
 *
 * The UI is always served from the same origin as the API (Vite proxies /api in
 * development), so no cross-origin caller is legitimate. The server used to send
 * CORS headers allowing every origin, which let any web page read the library
 * and start downloads or translations that spend API credit. Two checks keep
 * other pages out:
 *
 *  - `Sec-Fetch-Site`: browsers label each request with where it came from, so a
 *    request another site triggers -- a fetch, a form post, an `<img>` -- is
 *    refused before it can do anything. Removing CORS alone would not stop
 *    those: a body-less POST or an image load needs no CORS to fire.
 *  - `Host`: a DNS-rebinding page is same-origin with itself, but its requests
 *    still carry its own hostname. Only names that point at this machine pass.
 *
 * Requests without these headers (curl, the CLI, old browsers) are let through.
 */
import os from 'node:os';
import type { NextFunction, Request, Response } from 'express';

/** Hostnames this machine answers to: loopback, its own name, its addresses. */
function localHostnames(): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  const host = os.hostname().toLowerCase();
  names.add(host);
  names.add(`${host}.local`);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) names.add(entry.address.toLowerCase().replace(/%.*$/, ''));
  }
  for (const extra of (process.env.ALLOWED_HOSTS ?? '').split(',')) {
    const name = extra.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

let allowed = localHostnames();
const refused = new Set<string>();

/** `localhost:5180` -> `localhost`, `[::1]:5180` -> `::1`. */
function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  return host.split(':')[0];
}

function isLocalHost(name: string): boolean {
  if (allowed.has(name) || name.endsWith('.localhost')) return true;
  // Addresses change (DHCP, a VPN coming up); look again before refusing.
  allowed = localHostnames();
  return allowed.has(name);
}

export function guardApi(req: Request, res: Response, next: NextFunction): void {
  const site = req.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') {
    res.status(403).json({ error: 'requests from other sites are not accepted' });
    return;
  }

  const hostHeader = req.get('host');
  if (hostHeader) {
    const name = hostnameOf(hostHeader);
    if (!isLocalHost(name)) {
      if (!refused.has(name)) {
        refused.add(name);
        console.warn(`[access] refused Host "${name}"; add it to ALLOWED_HOSTS if it is yours`);
      }
      res.status(403).json({ error: `host "${name}" is not allowed; set ALLOWED_HOSTS to use it` });
      return;
    }
  }
  next();
}
