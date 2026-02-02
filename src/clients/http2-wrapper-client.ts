import { request as http2WrapperRequest } from 'http2-wrapper';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface ClientResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  httpVersion: string;
  alpnProtocol?: string;
}

export interface Http2WrapperClientConfig {
  rejectUnauthorized?: boolean;
  ca?: Buffer;
}

export class Http2WrapperClient {
  private config: Http2WrapperClientConfig;

  constructor(config: Http2WrapperClientConfig = {}) {
    this.config = {
      rejectUnauthorized: false,
      ...config,
    };

    // If CA is not provided, use the self-signed cert
    if (!this.config.ca && !this.config.rejectUnauthorized) {
      try {
        this.config.ca = readFileSync(join(process.cwd(), 'certs', 'server-cert.pem'));
      } catch (err) {
        // Ignore if cert file doesn't exist
      }
    }
  }

  async request(url: string): Promise<ClientResponse> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        protocol: parsedUrl.protocol,
        rejectUnauthorized: this.config.rejectUnauthorized,
        ca: this.config.ca,
        // Force ALPN protocols
        ALPNProtocols: ['h2', 'http/1.1'],
      };

      const req = http2WrapperRequest(options, (res: any) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');

          // Try to get ALPN protocol from socket
          let alpnProtocol: string | false = false;
          if (res.socket) {
            alpnProtocol = res.socket.alpnProtocol;
          }

          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[]>,
            body,
            httpVersion: res.httpVersion,
            alpnProtocol: alpnProtocol || undefined,
          });
        });

        res.on('error', (err: Error) => {
          reject(err);
        });
      });

      req.on('error', (err: Error) => {
        reject(err);
      });

      req.end();
    });
  }
}
