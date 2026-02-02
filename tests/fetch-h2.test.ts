import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockHTTPSServer } from "../src/server/https-server.js";
import { FetchH2Client } from "../src/clients/fetch-h2-client.js";

describe("HTTP/2 protocol", () => {
  let server: FetchH2Client;
  let client: Http2WrapperClient;
  const PORT = 9445;

  beforeEach(async () => {
    client = new FetchH2Client();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        if (clientProtocols.includes("h2")) return "h2";
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

  describe("basic request", () => {
    it("should use HTTP/2", async () => {
      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Hello from mock HTTPS server!");
      expect(response.headers["content-type"]).toBe("text/plain");

      expect(response.httpVersion).toBe("2.0");
      expect(response.headers["x-alpn-protocol"]).toBe("h2");
      expect(response.headers["x-http-version"]).toBe("2.0");

      const events = server.getEvents();
      const secureConnectionEvents = events.filter(
        (e) => e.type === "secureConnection",
      );
      expect(secureConnectionEvents.length).toBe(1);
      const secureConnectionEvent = secureConnectionEvents[0];
      expect(secureConnectionEvent?.clientProtocols).toEqual([
        "h2",
        "http/1.1",
      ]);
      expect(secureConnectionEvent?.selectedProtocol).toBe("h2");
      expect(secureConnectionEvent?.alpnProtocol).toBe("h2");

      const requestEvents = events.filter((e) => e.type === "request");
      expect(requestEvents.length).toBe(1);
      const requestEvent = requestEvents[0];
      expect(requestEvent?.requestMethod).toBe("GET");
      expect(requestEvent?.requestPath).toBe("/test");
      expect(requestEvent?.alpnProtocol).toBe("h2");
      expect(requestEvent?.httpVersion).toBe("2.0");

      expect(server.getTLSConnectionCount()).toBe(1);
      expect(server.getRequestCount()).toBe(1);
    });
  });
});

describe("HTTP/1.1 protocol", () => {
  let server: FetchH2Client;
  let client: Http2WrapperClient;
  const PORT = 9445;

  beforeEach(async () => {
    client = new FetchH2Client();
    server = new MockHTTPSServer({
      port: PORT,
      customALPNCallback: (clientProtocols) => {
        if (clientProtocols.includes("http/1.1")) return "http/1.1";
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

  describe("basic request", () => {
    it("should use HTTP/1.1", async () => {
      client = new FetchH2Client();
      const response = await client.request(`https://localhost:${PORT}/test`);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("Hello from mock HTTPS server!");
      expect(response.headers["content-type"]).toBe("text/plain");

      expect(response.httpVersion).toBe("1");
      expect(response.headers["x-alpn-protocol"]).toBe("none");
      expect(response.headers["x-http-version"]).toBe("1.1");

      const events = server.getEvents();
      const secureConnectionEvents = events.filter(
        (e) => e.type === "secureConnection",
      );
      expect(secureConnectionEvents.length).toBe(1);
      const secureConnectionEvent = secureConnectionEvents[0];
      expect(secureConnectionEvent?.clientProtocols).toEqual([
        "h2",
        "http/1.1",
      ]);
      expect(secureConnectionEvent?.selectedProtocol).toBe("http/1.1");
      expect(secureConnectionEvent?.alpnProtocol).toBe("http/1.1");

      const requestEvents = events.filter((e) => e.type === "request");
      expect(requestEvents.length).toBe(1);
      const requestEvent = requestEvents[0];
      expect(requestEvent?.requestMethod).toBe("GET");
      expect(requestEvent?.requestPath).toBe("/test");
      expect(requestEvent?.alpnProtocol).toBe(false);
      expect(requestEvent?.httpVersion).toBe("1.1");

      expect(server.getTLSConnectionCount()).toBe(1);
      expect(server.getRequestCount()).toBe(1);
    });
  });
});
