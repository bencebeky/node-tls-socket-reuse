import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockHTTPSServer, TLSConnectionEvent } from '../src/server/https-server.js';
import https from 'https';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('MockHTTPSServer - TLS and ALPN Events', () => {
  let server: MockHTTPSServer;
  const PORT = 9443;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('TLS Connection Events', () => {
    it('should capture connection and secureConnection events', async () => {
      server = new MockHTTPSServer({ port: PORT });
      await server.start();

      // Make a simple HTTPS request
      await makeRequest(`https://localhost:${PORT}/test`);

      const events = server.getEvents();

      // Should have connection, secureConnection, and request events
      expect(events.length).toBeGreaterThanOrEqual(3);

      const connectionEvent = events.find((e) => e.type === 'connection');
      const secureConnectionEvent = events.find((e) => e.type === 'secureConnection');
      const requestEvent = events.find((e) => e.type === 'request');

      expect(connectionEvent).toBeDefined();
      expect(connectionEvent?.timestamp).toBeInstanceOf(Date);

      expect(secureConnectionEvent).toBeDefined();
      expect(secureConnectionEvent?.timestamp).toBeInstanceOf(Date);

      expect(requestEvent).toBeDefined();
      expect(requestEvent?.timestamp).toBeInstanceOf(Date);
    });

    it('should track multiple connections separately', async () => {
      server = new MockHTTPSServer({ port: PORT });
      await server.start();

      // Make 3 separate requests sequentially to avoid socket hang ups
      await makeRequest(`https://localhost:${PORT}/test1`);
      await makeRequest(`https://localhost:${PORT}/test2`);
      await makeRequest(`https://localhost:${PORT}/test3`);

      const events = server.getEvents();
      const connectionEvents = events.filter((e) => e.type === 'connection');
      const requestEvents = events.filter((e) => e.type === 'request');

      // Should have multiple connection events
      expect(connectionEvents.length).toBeGreaterThanOrEqual(1);
      expect(requestEvents.length).toBe(3);

      // Verify each request has path information
      expect(requestEvents.map((e) => e.requestPath)).toContain('/test1');
      expect(requestEvents.map((e) => e.requestPath)).toContain('/test2');
      expect(requestEvents.map((e) => e.requestPath)).toContain('/test3');
    });
  });

  describe('ALPN Protocol Negotiation', () => {
    it('should receive ALPN protocols from client', async () => {
      const receivedProtocols: string[][] = [];

      server = new MockHTTPSServer({
        port: PORT,
        customALPNCallback: (clientProtocols) => {
          receivedProtocols.push([...clientProtocols]);
          // Always return http/1.1 for this test since native https module can't speak h2
          return 'http/1.1';
        },
      });
      await server.start();

      // Make request with h2 and http/1.1 support
      await makeRequest(`https://localhost:${PORT}/test`, ['h2', 'http/1.1']);

      const events = server.getEvents();
      const secureConnectionEvent = events.find((e) => e.type === 'secureConnection');

      // Verify the callback received the client's ALPN protocols
      expect(receivedProtocols.length).toBeGreaterThan(0);
      expect(receivedProtocols[0]).toContain('h2');
      expect(receivedProtocols[0]).toContain('http/1.1');

      // Verify event captured the protocols
      expect(secureConnectionEvent).toBeDefined();
      expect(secureConnectionEvent?.clientProtocols).toContain('h2');
      expect(secureConnectionEvent?.selectedProtocol).toBe('http/1.1');
    });

    it('should fallback to http/1.1 when h2 is not supported', async () => {
      server = new MockHTTPSServer({
        port: PORT,
        customALPNCallback: (clientProtocols) => {
          if (clientProtocols.includes('h2')) return 'h2';
          if (clientProtocols.includes('http/1.1')) return 'http/1.1';
          return undefined;
        },
      });
      await server.start();

      // Make request with only http/1.1 support
      await makeRequest(`https://localhost:${PORT}/test`, ['http/1.1']);

      const events = server.getEvents();
      const secureConnectionEvent = events.find((e) => e.type === 'secureConnection');

      expect(secureConnectionEvent).toBeDefined();
      expect(secureConnectionEvent?.clientProtocols).toContain('http/1.1');
      expect(secureConnectionEvent?.clientProtocols).not.toContain('h2');
      expect(secureConnectionEvent?.selectedProtocol).toBe('http/1.1');
      expect(secureConnectionEvent?.alpnProtocol).toBe('http/1.1');
    });

    it('should capture ALPN callback invocation', async () => {
      const receivedProtocols: string[][] = [];

      server = new MockHTTPSServer({
        port: PORT,
        customALPNCallback: (clientProtocols) => {
          receivedProtocols.push([...clientProtocols]);
          // Always return http/1.1 for this test since native https module can't speak h2
          return 'http/1.1';
        },
      });
      await server.start();

      await makeRequest(`https://localhost:${PORT}/test`, ['h2', 'http/1.1']);

      expect(receivedProtocols.length).toBeGreaterThanOrEqual(1);
      expect(receivedProtocols[0]).toContain('h2');
      expect(receivedProtocols[0]).toContain('http/1.1');
    });
  });

  describe('HTTP Request Tracking', () => {
    it('should capture HTTP request details', async () => {
      server = new MockHTTPSServer({ port: PORT });
      await server.start();

      await makeRequest(`https://localhost:${PORT}/api/test?foo=bar`);

      const events = server.getEvents();
      const requestEvent = events.find((e) => e.type === 'request');

      expect(requestEvent).toBeDefined();
      expect(requestEvent?.requestPath).toBe('/api/test?foo=bar');
      expect(requestEvent?.requestMethod).toBe('GET');
      expect(requestEvent?.httpVersion).toMatch(/^[12]\./);
    });

    it('should serve static text content', async () => {
      server = new MockHTTPSServer({ port: PORT });
      await server.start();

      const response = await makeRequest(`https://localhost:${PORT}/test`);

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/plain');
      expect(response.body).toContain('Hello from mock HTTPS server!');
    });

    it('should include ALPN protocol in response headers', async () => {
      server = new MockHTTPSServer({
        port: PORT,
        customALPNCallback: (clientProtocols) => {
          // Always return http/1.1 for this test since native https module can't speak h2
          return 'http/1.1';
        },
      });
      await server.start();

      const response = await makeRequest(`https://localhost:${PORT}/test`, ['h2', 'http/1.1']);

      expect(response.headers['x-alpn-protocol']).toBeDefined();
      expect(response.headers['x-alpn-protocol']).toBe('http/1.1');
    });
  });

  describe('Event Management', () => {
    it('should allow clearing events', async () => {
      server = new MockHTTPSServer({ port: PORT });
      await server.start();

      await makeRequest(`https://localhost:${PORT}/test`);
      expect(server.getEvents().length).toBeGreaterThan(0);

      server.clearEvents();
      expect(server.getEvents().length).toBe(0);
    });

    it('should return events in chronological order', async () => {
      server = new MockHTTPSServer({ port: PORT });
      await server.start();

      await makeRequest(`https://localhost:${PORT}/test`);

      const events = server.getEvents();
      expect(events.length).toBeGreaterThan(0);

      // Verify timestamps are in order
      for (let i = 1; i < events.length; i++) {
        expect(events[i].timestamp.getTime()).toBeGreaterThanOrEqual(
          events[i - 1].timestamp.getTime()
        );
      }
    });
  });
});

// Helper function to make HTTPS requests
function makeRequest(
  url: string,
  alpnProtocols?: string[]
): Promise<{ statusCode: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      rejectUnauthorized: false,
      ca: readFileSync(join(process.cwd(), 'certs', 'server-cert.pem')),
      // Prevent connection reuse issues
      agent: false,
    };

    if (alpnProtocols) {
      options.ALPNProtocols = alpnProtocols;
    }

    const req = https.request(options, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body,
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}
