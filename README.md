# Node.js TLS Socket Reuse

A comprehensive demonstration of HTTPS server with dynamic ALPN protocol configuration and HTTP/2 clients using `http2-wrapper` and `fetch-h2`.

## Features

- **Mock HTTPS Server** with configurable ALPN protocol negotiation
- **Event Tracking** for TLS connections, ALPN negotiation, and HTTP requests
- **HTTP/2 Client**: `http2-wrapper` with full HTTP/2 support
- **fetch-h2 Client**: Available for use (Fetch API interface for HTTP/2)
- **Comprehensive Tests** (21 passing tests) documenting server-side events and connection behavior

## Project Structure

```
node-tls-socket-reuse/
├── src/
│   ├── server/
│   │   └── https-server.ts       # Mock HTTPS server with ALPN
│   └── clients/
│       ├── http2-wrapper-client.ts  # http2-wrapper client
│       └── fetch-h2-client.ts       # fetch-h2 client
├── tests/
│   ├── server.test.ts            # Server TLS and ALPN tests
│   ├── http2-wrapper.test.ts     # http2-wrapper integration tests
│   └── fetch-h2.test.ts          # fetch-h2 integration tests
├── certs/                        # Self-signed certificates
└── vitest.config.ts              # Test configuration
```

## Installation

```bash
npm install
```

## Certificate Setup

The HTTPS server requires self-signed certificates for local development. Generate them with:

```bash
mkdir -p certs
cd certs
openssl req -x509 -newkey rsa:2048 -keyout server-key.pem -out server-cert.pem -days 365 -nodes -subj "/CN=localhost"
```

This creates:

- `certs/server-key.pem` - Private key
- `certs/server-cert.pem` - Self-signed certificate valid for 365 days

**Note:** The certificates are self-signed and intended for testing only. Your HTTP client may need to disable certificate validation (e.g., `rejectUnauthorized: false`).

## Usage

### Running the Server

```bash
npm run dev
```

The server will start on `https://localhost:8443`.

### Running Tests

```bash
# Run all tests
npm test

# Run tests with UI
npm test:ui
```

### Building

```bash
npm run build
```

## Server API

### MockHTTPSServer

The server captures and tracks the following events:

1. **connection**: Raw TCP connection established
2. **secureConnection**: TLS handshake completed, ALPN protocol negotiated
3. **request**: HTTP request received from client

```typescript
import { MockHTTPSServer } from "./src/server/https-server.js";

const server = new MockHTTPSServer({
  port: 8443,
  customALPNCallback: (clientProtocols) => {
    // Return preferred protocol: 'h2', 'http/1.1', or undefined
    return clientProtocols.includes("h2") ? "h2" : "http/1.1";
  },
});

await server.start();

// Get captured events
const events = server.getEvents();
console.log(events);

await server.stop();
```

### Event Structure

```typescript
interface TLSConnectionEvent {
  type: "connection" | "secureConnection" | "request" | "tlsClientError";
  timestamp: Date;
  alpnProtocol?: string | false; // Negotiated ALPN protocol
  clientProtocols?: string[]; // Protocols offered by client
  selectedProtocol?: string; // Protocol selected by server
  requestPath?: string; // HTTP request path
  requestMethod?: string; // HTTP method (GET, POST, etc.)
  httpVersion?: string; // HTTP version (1.1, 2.0)
  error?: string; // Error message if applicable
}
```

## Client APIs

### Http2WrapperClient

```typescript
import { Http2WrapperClient } from "./src/clients/http2-wrapper-client.js";

const client = new Http2WrapperClient();

// Single request
const response = await client.request("https://localhost:8443/test");
console.log(response.body);

// Multiple requests
const responses = await client.multipleRequests(
  "https://localhost:8443/test",
  5,
);
```

### FetchH2Client

```typescript
import { FetchH2Client } from "./src/clients/fetch-h2-client.js";

const client = new FetchH2Client();

// Single request
const response = await client.request("https://localhost:8443/test");
console.log(response.body);

// Multiple requests
const responses = await client.multipleRequests(
  "https://localhost:8443/test",
  5,
);

// Cleanup
await client.disconnect();
```

## Test Coverage

### Server Tests (`tests/server.test.ts`)

- TLS connection event tracking
- ALPN protocol negotiation (h2 and http/1.1)
- HTTP request handling
- Event management and ordering

### Client Tests

Both client test suites verify:

- Successful HTTPS requests
- HTTP/2 protocol negotiation
- TLS connection tracking
- ALPN protocol exchange
- Connection reuse for multiple requests
- Complete event sequence documentation

## Key Concepts Demonstrated

### ALPN (Application-Layer Protocol Negotiation)

The server demonstrates dynamic ALPN configuration, allowing you to control which protocol (HTTP/2 or HTTP/1.1) is selected based on client capabilities:

```typescript
customALPNCallback: (clientProtocols) => {
  console.log("Client offered:", clientProtocols);
  // Returns: ['h2', 'http/1.1']

  if (clientProtocols.includes("h2")) return "h2";
  if (clientProtocols.includes("http/1.1")) return "http/1.1";
  return undefined; // Reject connection
};
```

### Event Sequence

Typical event sequence for a single HTTP/2 request:

1. `connection` - TCP connection established
2. `secureConnection` - TLS handshake complete, ALPN negotiated
3. `request` - HTTP request received

### Connection Reuse

The tests demonstrate connection reuse patterns:

- **http2-wrapper**: May create multiple connections based on configuration
- **fetch-h2**: Efficiently reuses connections (typically 1 connection for multiple requests)

## Requirements

- Node.js 18+
- TypeScript 5+
- OpenSSL (for certificate generation)

## License

MIT
