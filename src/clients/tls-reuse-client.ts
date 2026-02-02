import * as tls from 'tls';
import * as http from 'http';
import * as http2 from 'http2';
import * as net from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import { URL } from 'url';

export interface ClientResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  httpVersion: string;
  alpnProtocol?: string;
}

export interface TLSReuseClientConfig {
  rejectUnauthorized?: boolean;
  ca?: Buffer;
}

interface CachedConnection {
  socket: tls.TLSSocket;
  session?: http2.ClientHttp2Session;
}

/**
 * TLSReuseClient opens a single TLS connection and properly reuses it
 * based on the negotiated ALPN protocol.
 *
 * This solves the issue where http2-wrapper's auto() opens two connections:
 * one for protocol detection and another for the actual request.
 *
 * Instead, this client:
 * 1. Opens ONE TLS connection
 * 2. Detects the negotiated ALPN protocol
 * 3. Reuses the same socket for either HTTP/1.1 or HTTP/2
 */
export class TLSReuseClient {
  private config: TLSReuseClientConfig;
  private connectionCache: Map<string, CachedConnection> = new Map();

  constructor(config: TLSReuseClientConfig = {}) {
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

  private async createTLSConnection(
    hostname: string,
    port: number
  ): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const options: tls.ConnectionOptions = {
        host: hostname,
        port,
        rejectUnauthorized: this.config.rejectUnauthorized,
        ca: this.config.ca,
        // Advertise both protocols to let the server choose
        ALPNProtocols: ['h2', 'http/1.1'],
        servername: hostname, // Important for SNI
      };

      const socket = tls.connect(options, () => {
        // Connection established
        resolve(socket);
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  private async makeHttp1Request(
    socket: tls.TLSSocket,
    parsedUrl: URL
  ): Promise<ClientResponse> {
    return new Promise((resolve, reject) => {
      const requestOptions = {
        createConnection: () => socket,
        host: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'Host': parsedUrl.host,
          'Connection': 'keep-alive', // Important for socket reuse
        },
      };

      const req = http.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');

          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[]>,
            body,
            httpVersion: res.httpVersion || '1.1',
            alpnProtocol: socket.alpnProtocol || undefined,
          });
        });

        res.on('error', (err) => {
          reject(err);
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      req.end();
    });
  }

  private async makeHttp2Request(
    connection: CachedConnection,
    parsedUrl: URL
  ): Promise<ClientResponse> {
    return new Promise((resolve, reject) => {
      // Create or reuse HTTP/2 session
      if (!connection.session || connection.session.destroyed) {
        connection.session = http2.connect(
          `https://${parsedUrl.hostname}:${parsedUrl.port || 443}`,
          {
            createConnection: () => connection.socket,
            rejectUnauthorized: this.config.rejectUnauthorized,
            ca: this.config.ca,
          }
        );

        connection.session.on('error', (err) => {
          // Session errors are logged but not necessarily fatal
          console.error('HTTP/2 session error:', err);
        });
      }

      const session = connection.session;

      // Make the request
      const req = session.request({
        ':method': 'GET',
        ':path': parsedUrl.pathname + parsedUrl.search,
        ':scheme': 'https',
        ':authority': parsedUrl.host,
      });

      req.on('error', (err) => {
        reject(err);
      });

      const chunks: Buffer[] = [];
      let headers: Record<string, string | string[]> = {};
      let statusCode = 0;

      req.on('response', (responseHeaders) => {
        // Extract status code from pseudo-header
        statusCode = parseInt(responseHeaders[':status'] as string || '0');

        // Convert the HTTP/2 headers to regular headers format (excluding pseudo-headers)
        for (const [key, value] of Object.entries(responseHeaders)) {
          if (!key.startsWith(':')) {
            headers[key] = value as string | string[];
          }
        }
      });

      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');

        resolve({
          statusCode,
          headers,
          body,
          httpVersion: '2.0',
          alpnProtocol: connection.socket.alpnProtocol || undefined,
        });
      });

      req.end();
    });
  }

  async request(url: string): Promise<ClientResponse> {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname;
    const port = parseInt(parsedUrl.port) || 443;
    const connectionKey = `${hostname}:${port}`;

    let connection: CachedConnection;

    // Check if we have a cached connection
    if (this.connectionCache.has(connectionKey)) {
      connection = this.connectionCache.get(connectionKey)!;

      // Check if the socket is still connected
      if (connection.socket.destroyed || !connection.socket.readable || !connection.socket.writable) {
        // Socket is no longer usable, remove from cache
        if (connection.session && !connection.session.destroyed) {
          connection.session.close();
        }
        this.connectionCache.delete(connectionKey);

        // Create new connection
        const socket = await this.createTLSConnection(hostname, port);
        connection = { socket };
        this.connectionCache.set(connectionKey, connection);
      }
    } else {
      // Create a new TLS connection
      const socket = await this.createTLSConnection(hostname, port);
      connection = { socket };
      this.connectionCache.set(connectionKey, connection);
    }

    // Determine which protocol was negotiated
    const alpnProtocol = connection.socket.alpnProtocol;

    if (alpnProtocol === 'h2') {
      // Use HTTP/2
      return this.makeHttp2Request(connection, parsedUrl);
    } else {
      // Use HTTP/1.1 (including when alpnProtocol is false or 'http/1.1')
      return this.makeHttp1Request(connection.socket, parsedUrl);
    }
  }

  /**
   * Close all cached connections
   */
  closeAll(): void {
    for (const connection of this.connectionCache.values()) {
      if (connection.session && !connection.session.destroyed) {
        connection.session.close();
      }
      if (!connection.socket.destroyed) {
        connection.socket.destroy();
      }
    }
    this.connectionCache.clear();
  }

  /**
   * Get the number of cached connections
   */
  getCachedSocketCount(): number {
    return this.connectionCache.size;
  }
}
