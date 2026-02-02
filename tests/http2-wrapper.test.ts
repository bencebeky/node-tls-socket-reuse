import { auto } from 'http2-wrapper';
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
        expect(clientProtocols).toEqual(['h2']);
        return 'h2';
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
        expect(clientProtocols).toEqual(['h2']);
        // server does not support HTTP/2
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
    it('should fail', async () => {
      // http2-wrapper sends ['h2'], server does not support HTTP/2,
      // therefore sends back no_application_protocol alert.
      let caughtError: unknown;
      try {
        await client.request(`https://localhost:${PORT}/test`);
      } catch(error) {
        caughtError = error
      }
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError.message).toContain('no application protocol');
      expect(caughtError.code).toBe('ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL');

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
        expect(clientProtocols).toContain('h2');
        return 'h2';
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

describe('Http2WrapperAutoClient with HTTP/1.1 then HTTP/2 ALPN response', () => {
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
          connectionCount++;
          expect(clientProtocols).toEqual(['h2', 'http/1.1']);
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
    if (server) {
      await server.stop();
    }
  });

  describe('basic request', () => {
    it('should fail', async () => {
      // http2-wrapper incorrectly assumes second TLS connection is HTTP/1.1 and
      // fails to parse HTTP/2 connection preface as HTTP/1.1 response.
      let caughtError: any = null;
      try {
        await autoClient.request(`https://localhost:${PORT}/test`);
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError.message).toBe('Parse Error: Expected HTTP/, RTSP/ or ICE/');
      expect(caughtError.code).toBe('HPE_INVALID_CONSTANT');

      const events = server.getEvents();

      const secureConnections = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnections.length).toBe(2);
      expect(secureConnections[0].selectedProtocol).toBe('http/1.1');
      expect(secureConnections[1].selectedProtocol).toBe('h2');

      const requests = server.getRequestCount();
      expect(requests).toBe(0);

      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(2);
      expect(clientProtocols[0]).toEqual(['h2', 'http/1.1']);
      expect(clientProtocols[1]).toEqual(['h2', 'http/1.1']);
    });
  });
});

describe('Http2WrapperAutoClient with HTTP/2 then HTTP/1.1 ALPN response', () => {
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
          connectionCount++;
          if (connectionCount === 1) {
            expect(clientProtocols).toEqual(['h2', 'http/1.1']);
            return 'h2';
          } else {
            // server does not support HTTP/2
            expect(clientProtocols).toEqual(['h2']);
            return undefined;
          }
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
    it('should fail', async () => {
      // http2-wrapper sends ['h2'] on the second connection, but server does
      // not support HTTP/2, therefore sends back no_application_protocol alert.
      let caughtError: any = null;
      try {
        await autoClient.request(`https://localhost:${PORT}/test`);
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError.message).toContain('no application protocol');
      expect(caughtError.code).toBe('ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL');

      const events = server.getEvents();

      const secureConnections = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnections.length).toBe(2);
      expect(secureConnections[0].selectedProtocol).toBe('h2');
      expect(secureConnections[1].selectedProtocol).toBeUndefined();

      const requests = server.getRequestCount();
      expect(requests).toBe(0);

      const clientProtocols = server.getClientALPNProtocols();
      expect(clientProtocols.length).toBe(2);
      expect(clientProtocols[0]).toEqual(['h2', 'http/1.1']);
      expect(clientProtocols[1]).toEqual(['h2']);
    });
  });
});

describe('Http2WrapperAutoClient with resolveProtocol with HTTP/1.1 server', () => {
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
        expect(clientProtocols).toEqual(['h2', 'http/1.1']);
        return 'http/1.1';
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
    it('should succeed', async () => {
      await autoClient.request(`https://localhost:${PORT}/test`, () => auto.createResolveProtocol(new Map(), new Map()));

      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(1);
      const secureConnectionEvent = secureConnectionEvents[0]; 

      // Client advertises both HTTP/2 and HTTP/1.1 on the first connection.
      expect(secureConnectionEvent?.clientProtocols).toEqual(['h2', 'http/1.1']);
      expect(secureConnectionEvent?.selectedProtocol).toBe('http/1.1');

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

describe('Http2WrapperAutoClient with resolveProtocol with HTTP/2 server', () => {
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
        expect(clientProtocols).toEqual(['h2', 'http/1.1']);
        return 'h2';
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
    it('should fail', async () => {
      // http2-wrapper advertises HTTP/2 support but in fact tries parsing the
      // response as HTTP/1.1 and fails
      let caughtError: any = null;
      try {
        await autoClient.request(`https://localhost:${PORT}/test`, () => auto.createResolveProtocol(new Map(), new Map()));
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBeInstanceOf(Error);
      expect(caughtError.message).toBe('Parse Error: Expected HTTP/, RTSP/ or ICE/');
      expect(caughtError.code).toBe('HPE_INVALID_CONSTANT');

      const events = server.getEvents();
      const secureConnectionEvents = events.filter((e) => e.type === 'secureConnection');
      expect(secureConnectionEvents.length).toBe(1);
      const secureConnectionEvent = secureConnectionEvents[0];

      expect(secureConnectionEvent?.clientProtocols).toEqual(['h2', 'http/1.1']);
      expect(secureConnectionEvent?.selectedProtocol).toBe('h2');

      const requestEvents = events.filter((e) => e.type === 'request');
      expect(requestEvents.length).toBe(0);
    });
  });
});
