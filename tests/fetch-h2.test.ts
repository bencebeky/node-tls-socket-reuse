import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockHTTPSServer } from '../src/server/https-server.js';
import { FetchH2Client } from '../src/clients/fetch-h2-client.js';

describe('FetchH2Client Integration Tests', () => {
  let server: MockHTTPSServer;
  let client: FetchH2Client;
  const PORT = 9445;

  beforeEach(async () => {
    client = new FetchH2Client();
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
    if (client) {
      await client.disconnect();
    }
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

      // fetch-h2 returns HTTP version
      expect(response.httpVersion).toBe('2.0');
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

  describe('Multiple Requests and Connection Reuse', () => {
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

    it('should reuse connections for multiple requests', async () => {
      server.clearEvents();

      await client.multipleRequests(`https://localhost:${PORT}/test`, 5);

      const events = server.getEvents();
      const connectionEvents = events.filter((e) => e.type === 'connection');
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      const requestEvents = events.filter((e) => e.type === 'request');

      // Should have 5 requests
      expect(requestEvents.length).toBe(5);

      // fetch-h2 should reuse the same connection for multiple requests
      // So we should have significantly fewer connections than requests
      expect(connectionEvents.length).toBeLessThan(requestEvents.length);
      expect(secureConnectionEvents.length).toBeLessThan(requestEvents.length);

      // All requests should use h2
      requestEvents.forEach((event) => {
        expect(event.alpnProtocol).toBe('h2');
      });
    });

    it('should demonstrate connection reuse with single connection for multiple requests', async () => {
      server.clearEvents();

      // Make 10 requests sequentially
      for (let i = 0; i < 10; i++) {
        await client.request(`https://localhost:${PORT}/test${i}`);
      }

      const events = server.getEvents();
      const connectionEvents = events.filter((e) => e.type === 'connection');
      const requestEvents = events.filter((e) => e.type === 'request');

      console.log('\n=== Connection Reuse Test ===');
      console.log(`Total Requests: ${requestEvents.length}`);
      console.log(`Total Connections: ${connectionEvents.length}`);
      console.log(`Reuse Ratio: ${(requestEvents.length / connectionEvents.length).toFixed(2)}x`);

      expect(requestEvents.length).toBe(10);
      // fetch-h2 should reuse connections efficiently
      expect(connectionEvents.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Event Sequence Documentation', () => {
    it('should document the complete event sequence for a single request', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();

      // Document the event sequence
      console.log('\n=== Event Sequence for fetch-h2 Client ===');
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

    it('should demonstrate event sequence with timestamps', async () => {
      server.clearEvents();

      await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();

      console.log('\n=== Detailed Event Timeline ===');
      const startTime = events[0]?.timestamp.getTime() || 0;

      events.forEach((event) => {
        const elapsed = event.timestamp.getTime() - startTime;
        console.log(`[+${elapsed}ms] ${event.type}`);
      });

      // Verify all events have valid timestamps
      events.forEach((event) => {
        expect(event.timestamp).toBeInstanceOf(Date);
        expect(event.timestamp.getTime()).toBeGreaterThan(0);
      });
    });
  });
});
