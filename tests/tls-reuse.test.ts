import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TLSReuseClient } from '../src/clients/tls-reuse-client';
import { MockHTTPSServer } from '../src/server/https-server';

describe('TLSReuseClient with HTTP/2 server', () => {
  let server: MockHTTPSServer;
  let client: TLSReuseClient;
  const PORT = 4445;

  beforeEach(async () => {
    client = new TLSReuseClient();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        expect(clientProtocols).toContain('h2');
        expect(clientProtocols).toContain('http/1.1');
        return 'h2';
      },
    });
    await server.start();
  });

  afterEach(async () => {
    client.closeAll();
    if (server) {
      await server.stop();
    }
  });

  describe('basic request', () => {
    it('should successfully make a request using HTTP/2', async () => {
      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.statusCode).toBe(200);
      expect(response.httpVersion).toBe('2.0');
      expect(response.alpnProtocol).toBe('h2');
      expect(response.body).toContain('Hello from mock HTTPS server!');

      // Verify only one TLS connection was made (not two like http2-wrapper auto)
      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(1);

      const secureConnectionEvent = secureConnectionEvents[0];
      expect(secureConnectionEvent?.clientProtocols).toEqual(['h2', 'http/1.1']);
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

  describe('multiple requests', () => {
    it('should reuse the same TLS socket for multiple HTTP/2 requests', async () => {
      const responses = await client.multipleRequests(
        `https://localhost:${PORT}/test`,
        3,
        true // reuse socket
      );

      // All requests should succeed
      expect(responses).toHaveLength(3);
      responses.forEach((response) => {
        expect(response.statusCode).toBe(200);
        expect(response.httpVersion).toBe('2.0');
        expect(response.alpnProtocol).toBe('h2');
      });

      // IMPORTANT: Only 1 TLS connection should have been made
      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(1);

      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(3);

      // Verify we have one cached socket
      expect(client.getCachedSocketCount()).toBe(1);
    });
  });
});

describe('TLSReuseClient with HTTP/1.1 server', () => {
  let server: MockHTTPSServer;
  let client: TLSReuseClient;
  const PORT = 4445;

  beforeEach(async () => {
    client = new TLSReuseClient();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        expect(clientProtocols).toContain('h2');
        expect(clientProtocols).toContain('http/1.1');
        return 'http/1.1';
      },
    });
    await server.start();
  });

  afterEach(async () => {
    client.closeAll();
    if (server) {
      await server.stop();
    }
  });

  describe('basic request', () => {
    it('should successfully make a request using HTTP/1.1', async () => {
      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.statusCode).toBe(200);
      expect(response.httpVersion).toBe('1.1');
      expect(response.alpnProtocol).toBe('http/1.1');
      expect(response.body).toContain('Hello from mock HTTPS server!');

      // Verify only one TLS connection was made
      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(1);

      const secureConnectionEvent = secureConnectionEvents[0];
      expect(secureConnectionEvent?.clientProtocols).toEqual(['h2', 'http/1.1']);
      expect(secureConnectionEvent?.selectedProtocol).toBe('http/1.1');
      expect(secureConnectionEvent?.alpnProtocol).toBe('http/1.1');

      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(1);
      const requestEvent = requestEvents[0];
      expect(requestEvent?.requestMethod).toBe('GET');
      expect(requestEvent?.requestPath).toBe('/test');
      expect(requestEvent?.alpnProtocol).toBe('http/1.1');
      expect(requestEvent?.httpVersion).toBe('1.1');
    });
  });

  describe('multiple requests', () => {
    it('should reuse the same TLS socket for multiple HTTP/1.1 requests', async () => {
      const responses = await client.multipleRequests(
        `https://localhost:${PORT}/test`,
        3,
        true // reuse socket
      );

      // All requests should succeed
      expect(responses).toHaveLength(3);
      responses.forEach((response) => {
        expect(response.statusCode).toBe(200);
        expect(response.httpVersion).toBe('1.1');
        expect(response.alpnProtocol).toBe('http/1.1');
      });

      // For HTTP/1.1 with keep-alive, we should still only have 1 connection
      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(1);

      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(3);

      // Verify we have one cached socket
      expect(client.getCachedSocketCount()).toBe(1);
    });
  });
});

describe('TLSReuseClient with protocol switching server', () => {
  let connectionCount = 0;
  let server: MockHTTPSServer;
  let client: TLSReuseClient;
  const PORT = 4445;

  beforeEach(async () => {
    connectionCount = 0;
    client = new TLSReuseClient();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        connectionCount++;
        expect(clientProtocols).toContain('h2');
        expect(clientProtocols).toContain('http/1.1');
        // First connection: return http/1.1
        // Second connection: return h2
        // This simulates the scenario that breaks http2-wrapper's auto()
        if (connectionCount === 1) {
          return 'http/1.1';
        } else {
          return 'h2';
        }
      },
    });
    await server.start();
  });

  afterEach(async () => {
    client.closeAll();
    if (server) {
      await server.stop();
    }
  });

  describe('resilience to protocol changes', () => {
    it('should handle server protocol changes gracefully', async () => {
      // First request - should negotiate HTTP/1.1
      const response1 = await client.request(
        `https://localhost:${PORT}/test`,
        false // don't reuse socket for this test
      );
      expect(response1.statusCode).toBe(200);
      expect(response1.httpVersion).toBe('1.1');
      expect(response1.alpnProtocol).toBe('http/1.1');

      // Second request - new client instance, server would negotiate HTTP/2
      const client2 = new TLSReuseClient();
      const response2 = await client2.request(`https://localhost:${PORT}/test`);
      expect(response2.statusCode).toBe(200);
      expect(response2.httpVersion).toBe('2.0');
      expect(response2.alpnProtocol).toBe('h2');

      // We should have 2 separate TLS connections
      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(2);

      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(2);

      client2.closeAll();
    });

    it('should NOT suffer from the protocol detection mismatch issue', async () => {
      // This test verifies that our client doesn't make a separate
      // "protocol detection" connection like http2-wrapper's auto() does
      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.statusCode).toBe(200);

      // Check the events to ensure only one TLS connection was made
      const events = server.getEvents();
      const tlsConnections = events.filter((e) => e.type === 'secureConnection');
      const requests = events.filter((e) => e.type === 'request');

      // Should have exactly 1 TLS connection and 1 request
      // (not 2 TLS connections like http2-wrapper's auto())
      expect(tlsConnections).toHaveLength(1);
      expect(requests).toHaveLength(1);

      // No tlsClientError events (which occur when auto() closes its sniffing connection)
      const errorEvents = events.filter((e) => e.type === 'tlsClientError');
      expect(errorEvents).toHaveLength(0);
    });
  });
});

describe('TLSReuseClient socket management', () => {
  let server: MockHTTPSServer;
  let client: TLSReuseClient;
  const PORT = 4445;

  beforeEach(async () => {
    client = new TLSReuseClient();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        if (clientProtocols.includes('h2')) {
          return 'h2';
        }
        return clientProtocols[0];
      },
    });
    await server.start();
  });

  afterEach(async () => {
    client.closeAll();
    if (server) {
      await server.stop();
    }
  });

  describe('socket caching', () => {
    it('should properly cache and reuse sockets', async () => {
      // Initially no cached sockets
      expect(client.getCachedSocketCount()).toBe(0);

      // Make first request
      await client.request(`https://localhost:${PORT}/test`);
      expect(client.getCachedSocketCount()).toBe(1);

      // Make second request to same server - should reuse socket
      await client.request(`https://localhost:${PORT}/test`);
      expect(client.getCachedSocketCount()).toBe(1);

      // Only 1 TLS connection should have been made
      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(1);

      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(2);
    });

    it('should create new socket when reuseSocket is false', async () => {
      // Make first request without socket reuse
      await client.request(`https://localhost:${PORT}/test`, false);
      expect(client.getCachedSocketCount()).toBe(0);

      // Make second request without socket reuse
      await client.request(`https://localhost:${PORT}/test`, false);
      expect(client.getCachedSocketCount()).toBe(0);

      // 2 TLS connections should have been made
      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(2);

      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(2);
    });

    it('should properly clean up sockets with closeAll()', async () => {
      // Make a request to cache a socket
      await client.request(`https://localhost:${PORT}/test`);
      expect(client.getCachedSocketCount()).toBe(1);

      // Close all sockets
      client.closeAll();
      expect(client.getCachedSocketCount()).toBe(0);

      // New request should create a new connection
      await client.request(`https://localhost:${PORT}/test`);

      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(2);
    });

    it('should recover from destroyed sockets', async () => {
      // Make first request to cache a socket
      const response1 = await client.request(`https://localhost:${PORT}/test`);
      expect(response1.statusCode).toBe(200);
      expect(client.getCachedSocketCount()).toBe(1);

      // Manually close all sockets (simulating a connection drop)
      client.closeAll();

      // Next request should detect the destroyed socket and create a new one
      const response2 = await client.request(`https://localhost:${PORT}/test`);
      expect(response2.statusCode).toBe(200);

      // Should have made 2 TLS connections total
      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(2);
    });
  });
});

describe('TLSReuseClient error handling', () => {
  let client: TLSReuseClient;

  beforeEach(() => {
    client = new TLSReuseClient();
  });

  afterEach(() => {
    client.closeAll();
  });

  describe('connection errors', () => {
    it('should handle connection errors gracefully', async () => {
      // Try to connect to a port where no server is listening
      const badPort = 9999;

      await expect(
        client.request(`https://localhost:${badPort}/test`)
      ).rejects.toThrow();
    });
  });
});
