import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockHTTPSServer } from '../src/server/https-server.js';
import { Http2WrapperClient } from '../src/clients/http2-wrapper-client.js';
import { Http2WrapperAutoClient } from '../src/clients/http2-wrapper-auto-client.js';

describe('Http2WrapperClient Integration Tests - Direct request() API', () => {
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
      server.clearEvents();

      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Hello from mock HTTPS server!');
      expect(response.headers['content-type']).toBe('text/plain');

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
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

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
    });

    it('should include ALPN protocol in response headers', async () => {
      server.clearEvents();

      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.headers['x-alpn-protocol']).toBe('h2');
      expect(response.headers['x-http-version']).toBe('2.0');

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
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

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
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

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
    });

    it('should track selected ALPN protocol sent to client', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();
      const secureConnectionEvent = events.find((e) => e.type === 'secureConnection');

      expect(secureConnectionEvent?.selectedProtocol).toBeDefined();
      expect(['h2', 'http/1.1']).toContain(secureConnectionEvent?.selectedProtocol);

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
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

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
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

      // Verify client advertised ALPN protocols on each connection
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBeGreaterThan(0);
      clientProtocols.forEach((protocols) => {
        expect(protocols).toEqual(['h2']);
      });
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

      // Verify client advertised ALPN protocols on each connection
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBeGreaterThan(0);
      clientProtocols.forEach((protocols) => {
        expect(protocols).toEqual(['h2']);
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

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
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

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
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

      // Verify client advertised ALPN protocols
      // http2-wrapper.request() with HTTP/2 only advertises 'h2'
      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(1);
      expect(clientProtocols[0]).toEqual(['h2']);
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
    it('should FAIL with client expecting HTTP/1 but server sending HTTP/2 connection preface', async () => {
      try {
        server.clearEvents();

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

        expect(caughtError).toBeTruthy();
        expect(caughtError.message).toBeTruthy();

        expect(caughtError.code).toBe('HPE_INVALID_CONSTANT');
        expect(caughtError.message).toContain('Parse Error: Expected HTTP/, RTSP/ or ICE/');

        const events = server.getEvents();
        const secureConnections = events.filter((e) => e.type === 'secureConnection');
        expect(secureConnections.length).toBe(1);
        expect(secureConnections[0].selectedProtocol).toBe('h2');

        const requests = server.getRequestCount();
        console.log(`\n[Result] HTTP Requests completed: ${requests}`);
        console.log('[Conclusion] The request failed due to protocol mismatch!');
        console.log('             Client expected h2 but connection has no ALPN (defaults to HTTP/1.1)');
        expect(requests).toBe(0);

        const clientProtocols = server.getClientALPNProtocols();
        expect(clientProtocols.length).toBe(1);
        expect(clientProtocols[0]).toEqual(['h2', 'http/1.1']); // First connection (ALPN sniffing)
      } finally {
        await server.stop();
      }
    });
  });
});
