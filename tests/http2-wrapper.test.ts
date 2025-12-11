import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockHTTPSServer } from '../src/server/https-server.js';
import { Http2WrapperClient } from '../src/clients/http2-wrapper-client.js';
import { Http2WrapperAutoClient } from '../src/clients/http2-wrapper-auto-client.js';

describe('Http2WrapperClient Integration Tests', () => {
  let server: MockHTTPSServer;
  let client: Http2WrapperClient;
  const PORT = 9444;

  beforeEach(async () => {
    client = new Http2WrapperClient();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        // Prefer h2, fallback to http/1.1
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

  describe('Basic HTTP/2 Requests', () => {
    it('should successfully make an HTTPS request', async () => {
      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Hello from mock HTTPS server!');
      expect(response.headers['content-type']).toBe('text/plain');
    });

    it('should negotiate HTTP/2 protocol', async () => {
      server.clearEvents();

      const response = await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();
      const secureConnectionEvent = events.find((e) => e.type === 'secureConnection');
      const requestEvent = events.find((e) => e.type === 'request');

      // Verify server received h2 in client protocols
      expect(secureConnectionEvent?.clientProtocols).toContain('h2');

      // Verify h2 was selected
      expect(secureConnectionEvent?.selectedProtocol).toBe('h2');
      expect(secureConnectionEvent?.alpnProtocol).toBe('h2');

      // Verify request was made with HTTP/2
      expect(requestEvent?.alpnProtocol).toBe('h2');
      expect(requestEvent?.httpVersion).toBe('2.0');
    });

    it('should include ALPN protocol in response headers', async () => {
      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.headers['x-alpn-protocol']).toBe('h2');
      expect(response.headers['x-http-version']).toBe('2.0');
    });
  });

  describe('Connection Tracking', () => {
    it('should track TLS connection opening', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();
      const connectionEvent = events.find((e) => e.type === 'connection');

      expect(connectionEvent).toBeDefined();
      expect(connectionEvent?.type).toBe('connection');
      expect(connectionEvent?.timestamp).toBeInstanceOf(Date);
    });

    it('should track ALPN protocols received from client', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();
      const secureConnectionEvent = events.find((e) => e.type === 'secureConnection');

      expect(secureConnectionEvent).toBeDefined();
      expect(secureConnectionEvent?.clientProtocols).toBeDefined();
      expect(Array.isArray(secureConnectionEvent?.clientProtocols)).toBe(true);
      expect(secureConnectionEvent?.clientProtocols).toContain('h2');
    });

    it('should track selected ALPN protocol sent to client', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();
      const secureConnectionEvent = events.find((e) => e.type === 'secureConnection');

      expect(secureConnectionEvent?.selectedProtocol).toBeDefined();
      expect(['h2', 'http/1.1']).toContain(secureConnectionEvent?.selectedProtocol);
    });

    it('should track HTTP request received from client', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/api/test`);

      const events = server.getEvents();
      const requestEvent = events.find((e) => e.type === 'request');

      expect(requestEvent).toBeDefined();
      expect(requestEvent?.type).toBe('request');
      expect(requestEvent?.requestMethod).toBe('GET');
      expect(requestEvent?.requestPath).toBe('/api/test');
      expect(requestEvent?.alpnProtocol).toBe('h2');
    });
  });

  describe('Multiple Requests', () => {
    it('should handle multiple sequential requests', async () => {
      server.clearEvents();

      const responses = await client.multipleRequests(`https://localhost:${PORT}/test`, 3);

      expect(responses.length).toBe(3);
      responses.forEach((response) => {
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('Hello from mock HTTPS server!');
      });

      // Verify all requests were tracked
      const events = server.getEvents();
      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(3);
    });

    it('should document connection reuse for multiple requests', async () => {
      server.clearEvents();

      await client.multipleRequests(`https://localhost:${PORT}/test`, 5);

      const events = server.getEvents();
      const connectionEvents = events.filter((e) => e.type === 'connection');
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      const requestEvents = events.filter((e) => e.type === 'request');

      // Should have fewer connections than requests due to connection reuse
      // Note: http2-wrapper may create multiple connections based on configuration
      expect(requestEvents.length).toBe(5);
      expect(connectionEvents.length).toBeGreaterThan(0);
      expect(secureConnectionEvents.length).toBeGreaterThan(0);

      // All requests should use the same protocol
      requestEvents.forEach((event) => {
        expect(event.alpnProtocol).toBe('h2');
      });
    });
  });

  describe('TLS Connection Efficiency', () => {
    it('should make only ONE TLS connection when ALPN protocols are specified', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/test`);

      // When http2-wrapper.request() is used with explicit ALPNProtocols in options,
      // it negotiates the protocol directly during the TLS handshake without needing
      // a separate connection for protocol detection (no ALPN sniffing)
      const tlsConnections = server.getTLSConnectionCount();
      const httpRequests = server.getRequestCount();

      console.log('\n=== http2-wrapper.request() Connection Pattern ===');
      console.log(`TLS Connections: ${tlsConnections}`);
      console.log(`HTTP Requests: ${httpRequests}`);
      console.log('Ratio: 1 TLS connection for 1 HTTP request');
      console.log('Implementation: Specifies ALPNProtocols: ["h2", "http/1.1"]');
      console.log('');
      console.log('Note: http2-wrapper.auto() would use ALPN sniffing (2 connections)');
      console.log('      but this client uses request() with explicit protocols');

      expect(httpRequests).toBe(1);
      expect(tlsConnections).toBe(1);
    });
  });

  describe('Event Sequence Documentation', () => {
    it('should document the complete event sequence for a single request', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();

      // Document the event sequence
      console.log('\n=== Event Sequence for http2-wrapper Client ===');
      events.forEach((event, index) => {
        console.log(`${index + 1}. ${event.type}`);
        if (event.clientProtocols) {
          console.log(`   Client ALPN Protocols: ${event.clientProtocols.join(', ')}`);
        }
        if (event.selectedProtocol) {
          console.log(`   Selected Protocol: ${event.selectedProtocol}`);
        }
        if (event.alpnProtocol) {
          console.log(`   Negotiated ALPN: ${event.alpnProtocol}`);
        }
        if (event.requestMethod && event.requestPath) {
          console.log(`   HTTP Request: ${event.requestMethod} ${event.requestPath}`);
          console.log(`   HTTP Version: ${event.httpVersion}`);
        }
      });

      // Verify expected event types are present
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('connection');
      expect(eventTypes).toContain('secureConnection');
      expect(eventTypes).toContain('request');
    });

    it('should show TLS handshake completes before HTTP request', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();

      const connectionIndex = events.findIndex((e) => e.type === 'connection');
      const secureConnectionIndex = events.findIndex((e) => e.type === 'secureConnection');
      const requestIndex = events.findIndex((e) => e.type === 'request');

      // Connection should come first, then secure connection, then request
      expect(connectionIndex).toBeGreaterThanOrEqual(0);
      expect(secureConnectionIndex).toBeGreaterThan(connectionIndex);
      expect(requestIndex).toBeGreaterThan(secureConnectionIndex);
    });
  });
});

describe('Http2WrapperAutoClient - ALPN Protocol Sniffing', () => {
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
        // Prefer h2, fallback to http/1.1
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

  describe('ALPN Sniffing with agent:false', () => {
    it('should make TWO TLS connections for a single request (ALPN sniffing)', async () => {
      server.clearEvents();

      await autoClient.request(`https://localhost:${PORT}/test`);

      // http2-wrapper's auto() function with agent:false performs ALPN sniffing:
      // 1. First TLS connection: Used to detect what protocols the server supports
      //    This connection is destroyed after detecting the protocol
      // 2. Second TLS connection: The actual connection used for the HTTP request
      const tlsConnections = server.getTLSConnectionCount();
      const httpRequests = server.getRequestCount();

      console.log('\n=== http2-wrapper auto() ALPN Sniffing (agent:false) ===');
      console.log(`TLS Connections: ${tlsConnections}`);
      console.log(`HTTP Requests: ${httpRequests}`);
      console.log('Ratio: 2 TLS connections for 1 HTTP request');
      console.log('Reason: auto() opens a first connection to detect ALPN protocol,');
      console.log('        then destroys it and opens a second connection for the request');
      console.log('Implementation: Uses agent:false to prevent socket reuse');
      console.log('');
      console.log('Note: This demonstrates the ALPN sniffing overhead when socket');
      console.log('      reuse is disabled (e.g., with custom agents or proxies)');

      expect(httpRequests).toBe(1);
      expect(tlsConnections).toBe(2);
    });

    it('should show two connection sequences for one HTTP request', async () => {
      server.clearEvents();

      const response = await autoClient.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();
      const connectionEvents = events.filter((e) => e.type === 'connection');
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      const requestEvents = events.filter((e) => e.type === 'request');
      const errorEvents = events.filter((e) => e.type === 'tlsClientError');

      console.log('\n=== Event Sequence with ALPN Sniffing ===');
      events.forEach((event, index) => {
        console.log(`${index + 1}. ${event.type}`);
        if (event.clientProtocols) {
          console.log(`   Client ALPN Protocols: ${event.clientProtocols.join(', ')}`);
        }
        if (event.selectedProtocol) {
          console.log(`   Selected Protocol: ${event.selectedProtocol}`);
        }
        if (event.type === 'tlsClientError') {
          console.log(`   (First connection destroyed after ALPN detection)`);
        }
        if (event.requestMethod && event.requestPath) {
          console.log(`   HTTP Request: ${event.requestMethod} ${event.requestPath}`);
          console.log(`   (This happens on the 2nd connection)`);
        }
      });

      // Should have 2 TCP connections
      expect(connectionEvents.length).toBe(2);
      // Should have 2 TLS handshakes (one for sniffing, one for the request)
      expect(secureConnectionEvents.length).toBe(2);
      // The first connection is destroyed, causing a TLS error event
      expect(errorEvents.length).toBe(1);
      // But only 1 actual HTTP request
      expect(requestEvents.length).toBe(1);

      expect(response.statusCode).toBe(200);
    });

    it('should FAIL when server changes ALPN protocol between connections', async () => {
      // Create a new server that alternates ALPN protocol responses
      await server.stop();

      let connectionCount = 0;
      const alternatingServer = new MockHTTPSServer({
        port: PORT,
        customALPNCallback: (clientProtocols) => {
          connectionCount++;
          console.log(`\n[Server] Connection #${connectionCount}, client offers: ${clientProtocols.join(', ')}`);

          // First connection (ALPN sniffing): respond with http/1.1
          // Second connection (actual request): respond with h2
          if (connectionCount === 1) {
            console.log('[Server] Responding with: http/1.1 (cache this!)');
            return 'http/1.1';
          } else {
            console.log('[Server] Responding with: h2 (different from cache!)');
            return 'h2';
          }
        },
      });
      await alternatingServer.start();

      try {
        alternatingServer.clearEvents();

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

        console.log('\n[Analysis] Why this specific error?');
        console.log('- Client thinks connection is HTTP/1.1 (from cache)');
        console.log('- Client sends HTTP/1.1 text: "GET /test HTTP/1.1\\r\\n..."');
        console.log('- But connection is actually HTTP/2 (h2)');
        console.log('- Server sends HTTP/2 binary frames back');
        console.log('- HTTP/1.1 parser receives binary data instead of "HTTP/"');
        console.log('- Parser error: HPE_INVALID_CONSTANT - Expected HTTP/, got binary');

        const events = alternatingServer.getEvents();
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
        const requests = alternatingServer.getRequestCount();
        console.log(`\n[Result] HTTP Requests completed: ${requests}`);
        console.log('[Conclusion] The request failed due to protocol mismatch!');
        console.log('             Client expected http/1.1 but connection is h2');
        expect(requests).toBe(0);

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
        alternatingServer.clearEvents();

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

      } finally {
        await alternatingServer.stop();
      }
    });
  });
});
