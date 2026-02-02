import { auto } from "http2-wrapper";
import { readFileSync } from "fs";
import { join } from "path";
import type { IncomingMessage } from "http";

export interface ClientResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  httpVersion: string;
  alpnProtocol?: string;
}

export interface Http2WrapperAutoClientConfig {
  rejectUnauthorized?: boolean;
  ca?: Buffer;
}

/**
 * Http2WrapperAutoClient uses http2-wrapper's auto() function which
 * performs ALPN protocol sniffing by:
 * 1. Opening a first TLS connection to detect what protocols the server supports
 * 2. Opening a second TLS connection for the actual HTTP request
 *
 * This results in 2 TLS connections for each HTTP request.
 */
export class Http2WrapperAutoClient {
  private config: Http2WrapperAutoClientConfig;

  constructor(config: Http2WrapperAutoClientConfig = {}) {
    this.config = {
      rejectUnauthorized: false,
      ...config,
    };

    // If CA is not provided, use the self-signed cert
    if (!this.config.ca && !this.config.rejectUnauthorized) {
      try {
        this.config.ca = readFileSync(
          join(process.cwd(), "certs", "server-cert.pem"),
        );
      } catch (err) {
        // Ignore if cert file doesn't exist
      }
    }
  }

  async request(url: string): Promise<ClientResponse> {
    return new Promise(async (resolve, reject) => {
      const parsedUrl = new URL(url);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "GET",
        protocol: parsedUrl.protocol,
        rejectUnauthorized: this.config.rejectUnauthorized,
        ca: this.config.ca,
        // Set agent: false to prevent socket reuse, forcing ALPN sniffing
        // to create a separate connection that gets destroyed
        agent: false,
        // Intentionally do NOT specify ALPNProtocols here
        // The auto() function will detect and negotiate the protocol automatically
      };

      try {
        // auto() is an async function that returns a ClientRequest
        const req = await auto(options, (res: IncomingMessage) => {
          const chunks: Buffer[] = [];

          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
          });

          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf-8");

            // Try to get ALPN protocol from socket
            let alpnProtocol: string | false = false;
            if (res.socket && "alpnProtocol" in res.socket) {
              alpnProtocol = (res.socket as any).alpnProtocol;
            }

            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers as Record<string, string | string[]>,
              body,
              httpVersion: res.httpVersion || "1.1",
              alpnProtocol: alpnProtocol || undefined,
            });
          });

          res.on("error", (err: Error) => {
            reject(err);
          });
        });

        req.on("error", (err: Error) => {
          reject(err);
        });

        req.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  async multipleRequests(
    url: string,
    count: number,
  ): Promise<ClientResponse[]> {
    const requests: Promise<ClientResponse>[] = [];

    for (let i = 0; i < count; i++) {
      requests.push(this.request(url));
    }

    return Promise.all(requests);
  }
}
