import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockHTTPSServer } from '../src/server/https-server.js';
import { Http2WrapperClient } from '../src/clients/http2-wrapper-client.js';
import { Http2WrapperAutoClient } from '../src/clients/http2-wrapper-auto-client.js';

describe('Http2WrapperClient with HTTP/2 server', () => {
  let server: MockHTTPSServer;
  let client: Http2WrapperClient;
  const PORT = 9444;

  beforeEach(async () => {
    client = new Http2WrapperClient();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        if (clientProtocols.includes('h2')) return 'h2';
        return undefined;
      },
    });
    await server.start();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('basic request', () => {
    it('should use HTTP/2', async () => {
      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Hello from mock HTTPS server!');
      expect(response.headers['content-type']).toBe('text/plain');

      expect(response.httpVersion).toBe('2.0');
      expect(response.headers['x-alpn-protocol']).toBe('h2');
      expect(response.headers['x-http-version']).toBe('2.0');

      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(1);
      const secureConnectionEvent = secureConnectionEvents[0]; 
      expect(secureConnectionEvent?.clientProtocols).toEqual(['h2']);
      expect(secureConnectionEvent?.selectedProtocol).toBe('h2');
      expect(secureConnectionEvent?.alpnProtocol).toBe('h2');

      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(1);
      const requestEvent = requestEvents[0];
      expect(requestEvent?.requestMethod).toBe('GET');
      expect(requestEvent?.requestPath).toBe('/test');
      expect(requestEvent?.alpnProtocol).toBe('h2');
      expect(requestEvent?.httpVersion).toBe('2.0');
    });
  });
});

describe('Http2WrapperClient with HTTP/1.1 server', () => {
  let server: MockHTTPSServer;
  let client: Http2WrapperClient;
  const PORT = 9444;

  beforeEach(async () => {
    client = new Http2WrapperClient();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        return undefined;
      },
    });
    await server.start();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('basic request', () => {
    it('should use HTTP/2', async () => {
      // Client sends ['h2'], server does not support HTTP/2,
      // therefore sends no_application_protocol alert.
      let error: unknown;
      try {
        const response = await client.request(`https://localhost:${PORT}/test`);
      } catch(e) {
        error = e
      }
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('no application protocol');
      expect(error.code).toBe('ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL');

      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(1);
      const secureConnectionEvent = secureConnectionEvents[0];
      expect(secureConnectionEvent?.clientProtocols).toEqual(['h2']);
      expect(secureConnectionEvent?.selectedProtocol).toBeUndefined();
      expect(secureConnectionEvent?.alpnProtocol).toBeUndefined();
    });
  });
});

describe('Http2WrapperAutoClient with HTTP/2 server', () => {
  let server: MockHTTPSServer;
  let autoClient: Http2WrapperAutoClient;
  const PORT = 9447;

  beforeEach(async () => {
    // Clear the auto() protocol cache before each test to force protocol detection
    const { auto } = await import('http2-wrapper');
    auto.protocolCache.clear();

    autoClient = new Http2WrapperAutoClient();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        if (clientProtocols.includes('h2')) return 'h2';
        if (clientProtocols.includes('http/1.1')) return 'http/1.1';
        return undefined;
      },
    });
    await server.start();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('basic request', () => {
    it('should make two TLS connections for a single request (ALPN sniffing)', async () => {
      await autoClient.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(2);
      const secureConnectionEvent = secureConnectionEvents[0];

      // Client advertises both HTTP/2 and HTTP/1.1 on the first connection.
      expect(secureConnectionEvents[0].clientProtocols).toEqual(['h2', 'http/1.1']);
      expect(secureConnectionEvents[0].selectedProtocol).toBe('h2');

      // Client only advertises HTTP/2 on the second connection because of
      // cached protocol value from first connection.
      expect(secureConnectionEvents[1].clientProtocols).toEqual(['h2']);
      expect(secureConnectionEvents[1].selectedProtocol).toBe('h2');
      expect(secureConnectionEvents[1].alpnProtocol).toBe('h2');

      // The client closes the first connection after the TLS handshake, which
      // the server registers as a client error.
      const errorEvents = events.filter((e) => e.type === 'tlsClientError');
      expect(errorEvents.length).toBe(1);

      // The only request is the one sent over the second connection.
      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(1);
      const requestEvent = requestEvents[0];
      expect(requestEvent?.requestMethod).toBe('GET');
      expect(requestEvent?.requestPath).toBe('/test');
      expect(requestEvent?.alpnProtocol).toBe('h2');
      expect(requestEvent?.httpVersion).toBe('2.0');
    });
  });
});

describe('Http2WrapperAutoClient with HTTP/2 server', () => {
  let connectionCount = 0;
  let server: MockHTTPSServer;
  let autoClient: Http2WrapperAutoClient;
  const PORT = 9447;

  beforeEach(async () => {
    // Clear the auto() protocol cache before each test to force protocol detection
    const { auto } = await import('http2-wrapper');
    auto.protocolCache.clear();

    autoClient = new Http2WrapperAutoClient();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
          if (connectionCount === 0) {
            return 'http/1.1';
          } else {
            return 'h2';
          }
          connectionCount++;
      },
    });
    await server.start();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('basic request', () => {
    it('should FAIL when server changes ALPN protocol between connections', async () => {
      const alternatingServer = new MockHTTPSServer({
        port: PORT,
        customALPNCallback: (clientProtocols) => {
        },
      });
      await alternatingServer.start();

      try {
        console.log('\n[Test] Making request with auto()...');
        console.log('[Problem] This demonstrates the ALPN sniffing cache issue:');
        console.log('  1. Preflight connection (destroyed) -> server says http/1.1');
        console.log('  2. auto() caches: "use http/1.1 for this host"');
        console.log('  3. Actual request connection -> server says h2');
        console.log('  4. Client tries HTTP/1.1 over h2 connection -> PROTOCOL MISMATCH!');

        // This should fail because:
        // 1. First connection detects http/1.1, caches it
        // 2. auto() decides to use http/1.1 for the request
        // 3. Second connection actually negotiates h2
        // 4. Client tries to send HTTP/1.1 request over h2 connection -> FAILS
        let caughtError: any = null;
        try {
          await autoClient.request(`https://localhost:${PORT}/test`);
          throw new Error('Expected request to fail but it succeeded!');
        } catch (error) {
          caughtError = error;
          console.log('\n[Error Details]');
          console.log('Error type:', error.constructor.name);
          console.log('Error message:', error.message);
          console.log('Error code:', (error as any).code);
          console.log('Full error object:', JSON.stringify({
            name: error.constructor.name,
            message: error.message,
            code: (error as any).code,
            errno: (error as any).errno,
            syscall: (error as any).syscall,
          }, null, 2));
        }

        // Verify we caught an error
        expect(caughtError).toBeTruthy();
        expect(caughtError.message).toBeTruthy();

        // Verify it's the expected HTTP parser error
        // When http2-wrapper tries to send HTTP/1.1 over an h2 connection,
        // the HTTP parser receives h2 frames instead of HTTP/1.1 text
        expect(caughtError.message).toBe('Parse Error: Expected HTTP/, RTSP/ or ICE/');
        expect(caughtError.code).toBe('HPE_INVALID_CONSTANT');

        const events = server.getEvents();
        console.log('\n[Events showing the protocol mismatch]');
        events.forEach((e, i) => {
          console.log(`${i + 1}. ${e.type}${e.selectedProtocol ? ` (ALPN: ${e.selectedProtocol})` : ''}`);
        });

        // We should see 2 TLS connections with different ALPN protocols
        const secureConnections = events.filter((e) => e.type === 'secureConnection');
        expect(secureConnections.length).toBe(2);
        expect(secureConnections[0].selectedProtocol).toBe('http/1.1');
        expect(secureConnections[1].selectedProtocol).toBe('h2');

        // No HTTP request should succeed
        const requests = server.getRequestCount();
        console.log(`\n[Result] HTTP Requests completed: ${requests}`);
        console.log('[Conclusion] The request failed due to protocol mismatch!');
        console.log('             Client expected http/1.1 but connection is h2');
        expect(requests).toBe(0);

        // Verify client advertised ALPN protocols on both connections
        const clientProtocols = server.getClientALPNProtocols();
        expect(clientProtocols.length).toBe(2);
        expect(clientProtocols[0]).toEqual(['h2', 'http/1.1']); // First connection (ALPN sniffing)
        expect(clientProtocols[1]).toEqual(['h2', 'http/1.1']); // Second connection (actual request)

      } finally {
        await alternatingServer.stop();
      }
    });

    it('should FAIL when server changes from h2 to http/1.1 between connections', async () => {
      // Create a new server that alternates ALPN protocol responses (opposite direction)
      await server.stop();

      let connectionCount = 0;
      const alternatingServer = new MockHTTPSServer({
        port: PORT,
        customALPNCallback: (clientProtocols) => {
          connectionCount++;
          console.log(`\n[Server] Connection #${connectionCount}, client offers: ${clientProtocols.join(', ')}`);

          // First connection (ALPN sniffing): respond with h2
          // Second connection (actual request): no ALPN extension (falls back to http/1.1)
          if (connectionCount === 1) {
            console.log('[Server] Responding with: h2 (cache this!)');
            return 'h2';
          } else {
            console.log('[Server] Responding with: undefined (no ALPN extension)');
            console.log('[Server] This means the connection defaults to HTTP/1.1');
            return undefined;
          }
        },
      });
      await alternatingServer.start();

      try {
        console.log('\n[Test] Making request with auto()...');
        console.log('[Problem] This demonstrates the ALPN sniffing cache issue:');
        console.log('  1. Preflight connection (destroyed) -> server says h2');
        console.log('  2. auto() caches: "use h2 for this host"');
        console.log('  3. Actual request connection -> server omits ALPN (defaults to HTTP/1.1)');
        console.log('  4. Client tries HTTP/2 over http/1.1 connection -> PROTOCOL MISMATCH!');

        // This should fail because:
        // 1. First connection detects h2, caches it
        // 2. auto() decides to use h2 for the request
        // 3. Second connection: server doesn't send ALPN extension (correct behavior)
        // 4. Connection defaults to HTTP/1.1
        // 5. Client tries to send HTTP/2 frames over http/1.1 connection -> FAILS
        let caughtError: any = null;
        try {
          await autoClient.request(`https://localhost:${PORT}/test`);
          throw new Error('Expected request to fail but it succeeded!');
        } catch (error) {
          caughtError = error;
          console.log('\n[Error Details]');
          console.log('Error type:', error.constructor.name);
          console.log('Error message:', error.message);
          console.log('Error code:', (error as any).code);
          console.log('Full error object:', JSON.stringify({
            name: error.constructor.name,
            message: error.message,
            code: (error as any).code,
            errno: (error as any).errno,
            syscall: (error as any).syscall,
          }, null, 2));
        }

        // Verify we caught an error
        expect(caughtError).toBeTruthy();
        expect(caughtError.message).toBeTruthy();

        // When the client only offers h2 and the server omits the ALPN extension,
        // Node.js/OpenSSL still sends a TLS alert 120 (no_application_protocol)
        // This happens even though the server behavior is technically correct
        expect(caughtError.code).toBe('ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL');
        expect(caughtError.message).toContain('tlsv1 alert no application protocol');

        console.log('\n[Analysis] Why this specific error?');
        console.log('- Client cached h2 from preflight connection');
        console.log('- On 2nd connection, client ONLY offers h2 (not http/1.1)');
        console.log('- Server does NOT send ALPN extension (correct server behavior)');
        console.log('- Node.js/OpenSSL client sends TLS alert 120: no_application_protocol');
        console.log('- Error code: ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL');
        console.log('');
        console.log('[Note] This demonstrates that even with correct server behavior');
        console.log('       (omitting ALPN when no common protocol exists), the client');
        console.log('       still fails at TLS handshake due to expecting h2 from cache');

        const events = alternatingServer.getEvents();
        console.log('\n[Events showing the protocol mismatch]');
        events.forEach((e, i) => {
          console.log(`${i + 1}. ${e.type}${e.selectedProtocol ? ` (ALPN: ${e.selectedProtocol})` : ' (no ALPN)'}`);
        });

        // We should see 2 TLS connections with different ALPN protocols
        const secureConnections = events.filter((e) => e.type === 'secureConnection');
        expect(secureConnections.length).toBe(2);
        expect(secureConnections[0].selectedProtocol).toBe('h2');
        expect(secureConnections[1].selectedProtocol).toBeUndefined(); // No ALPN extension

        // No HTTP request should succeed
        const requests = alternatingServer.getRequestCount();
        console.log(`\n[Result] HTTP Requests completed: ${requests}`);
        console.log('[Conclusion] The request failed due to protocol mismatch!');
        console.log('             Client expected h2 but connection has no ALPN (defaults to HTTP/1.1)');
        expect(requests).toBe(0);

        // Verify client advertised ALPN protocols on both connections
        const clientProtocols = alternatingServer.getClientALPNProtocols();
        expect(clientProtocols.length).toBe(2);
        expect(clientProtocols[0]).toEqual(['h2', 'http/1.1']); // First connection (ALPN sniffing)
        expect(clientProtocols[1]).toEqual(['h2']); // Second connection only offers h2 (cached from first)

      } finally {
        await alternatingServer.stop();
      }
    });
  });
});
