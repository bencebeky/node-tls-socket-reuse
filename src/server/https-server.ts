import { createSecureServer, Http2SecureServer, Http2ServerRequest, Http2ServerResponse } from 'http2';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { TLSSocket } from 'tls';

export interface TLSConnectionEvent {
  type: 'connection' | 'secureConnection' | 'request' | 'tlsClientError';
  timestamp: Date;
  alpnProtocol?: string | false;
  clientProtocols?: string[];
  selectedProtocol?: string;
  requestPath?: string;
  requestMethod?: string;
  httpVersion?: string;
  error?: string;
}

export interface ServerConfig {
  port: number;
  allowedProtocols?: string[];
  allowHTTP1?: boolean;
  customALPNCallback?: (clientProtocols: string[]) => string | undefined;
}

export class MockHTTPSServer {
  private server: Http2SecureServer;
  private events: TLSConnectionEvent[] = [];
  private config: ServerConfig;
  private listening = false;

  constructor(config: ServerConfig) {
    this.config = {
      allowHTTP1: true,
      allowedProtocols: ['h2', 'http/1.1'],
      ...config,
    };

    const certPath = join(process.cwd(), 'certs');

    const serverOptions: any = {
      key: readFileSync(join(certPath, 'server-key.pem')),
      cert: readFileSync(join(certPath, 'server-cert.pem')),
      allowHTTP1: this.config.allowHTTP1,
    };

    // Add custom ALPN callback if provided
    if (this.config.customALPNCallback) {
      serverOptions.ALPNCallback = (options: { servername: string; protocols: string[] }) => {
        this.events.push({
          type: 'secureConnection',
          timestamp: new Date(),
          clientProtocols: options.protocols,
        });

        const selected = this.config.customALPNCallback!(options.protocols);

        if (selected) {
          this.events[this.events.length - 1].selectedProtocol = selected;
        }

        return selected;
      };
    }

    this.server = createSecureServer(serverOptions, this.handleRequest.bind(this));

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    // Track raw TCP connection
    this.server.on('connection', (socket) => {
      this.events.push({
        type: 'connection',
        timestamp: new Date(),
      });
    });

    // Track TLS handshake completion
    this.server.on('secureConnection', (tlsSocket: TLSSocket) => {
      // Only add if not already added by ALPNCallback
      if (!this.config.customALPNCallback) {
        this.events.push({
          type: 'secureConnection',
          timestamp: new Date(),
          alpnProtocol: tlsSocket.alpnProtocol,
        });
      } else {
        // Update the last event with alpnProtocol
        const lastEvent = this.events[this.events.length - 1];
        if (lastEvent && lastEvent.type === 'secureConnection') {
          lastEvent.alpnProtocol = tlsSocket.alpnProtocol;
        }
      }
    });

    // Track TLS errors
    this.server.on('tlsClientError', (err, tlsSocket) => {
      this.events.push({
        type: 'tlsClientError',
        timestamp: new Date(),
        error: err.message,
      });
    });
  }

  private handleRequest(req: Http2ServerRequest, res: Http2ServerResponse): void {
    // Determine the ALPN protocol
    let alpnProtocol: string | false = false;

    if (req.httpVersion === '2.0') {
      // HTTP/2 request
      alpnProtocol = (req.stream.session.socket as TLSSocket).alpnProtocol;
    } else {
      // HTTP/1.x request
      alpnProtocol = (req.socket as TLSSocket).alpnProtocol;
    }

    this.events.push({
      type: 'request',
      timestamp: new Date(),
      alpnProtocol,
      requestPath: req.url,
      requestMethod: req.method,
      httpVersion: req.httpVersion,
    });

    // Serve static text content
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-alpn-protocol': alpnProtocol || 'none',
      'x-http-version': req.httpVersion,
    });

    res.end('Hello from mock HTTPS server!\n');
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, () => {
        this.listening = true;
        resolve();
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.listening) {
        resolve();
        return;
      }

      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.listening = false;
          resolve();
        }
      });
    });
  }

  getEvents(): TLSConnectionEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events = [];
  }

  getPort(): number {
    return this.config.port;
  }

  isListening(): boolean {
    return this.listening;
  }

  /**
   * Get the count of TLS connections (secureConnection events)
   * This represents the number of completed TLS handshakes
   */
  getTLSConnectionCount(): number {
    return this.events.filter((e) => e.type === 'secureConnection').length;
  }

  /**
   * Get the count of TCP connections (connection events)
   * This represents the raw number of TCP sockets opened
   */
  getTCPConnectionCount(): number {
    return this.events.filter((e) => e.type === 'connection').length;
  }

  /**
   * Get the count of HTTP requests
   */
  getRequestCount(): number {
    return this.events.filter((e) => e.type === 'request').length;
  }
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new MockHTTPSServer({
    port: 8443,
    customALPNCallback: (clientProtocols) => {
      console.log('Client ALPN protocols:', clientProtocols);
      // Prefer h2, fallback to http/1.1
      if (clientProtocols.includes('h2')) return 'h2';
      if (clientProtocols.includes('http/1.1')) return 'http/1.1';
      return undefined;
    },
  });

  await server.start();
  console.log('Mock HTTPS server listening on https://localhost:8443');
  console.log('Press Ctrl+C to stop');

  process.on('SIGINT', async () => {
    console.log('\nStopping server...');
    await server.stop();
    console.log('Server stopped');
    process.exit(0);
  });
}
