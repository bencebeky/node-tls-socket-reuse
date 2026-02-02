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
        expect(clientProtocols).toEqual(['h2', 'http/1.1']);
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
        expect(clientProtocols).toEqual(['h2', 'http/1.1']);
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
});
