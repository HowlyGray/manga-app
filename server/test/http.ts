/**
 * Serves the app on a spare loopback port for a test file. Uses node:http so
 * the Host header can be set, which fetch does not allow.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: <T = any>() => T;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
}

export async function startApp(): Promise<{
  request: (pathname: string, options?: RequestOptions) => Promise<Reply>;
  close: () => void;
}> {
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const request = (pathname: string, { method = 'GET', headers = {}, json }: RequestOptions = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const body = json === undefined ? undefined : JSON.stringify(json);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: pathname,
          method,
          headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: text,
              json: () => JSON.parse(text),
            });
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });

  return { request, close: () => server.close() };
}
