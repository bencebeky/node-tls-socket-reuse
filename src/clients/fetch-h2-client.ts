import { context, fetch, disconnectAll } from 'fetch-h2';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface ClientResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  httpVersion?: string;
}

export interface FetchH2ClientConfig {
  rejectUnauthorized?: boolean;
}

export class FetchH2Client {
  private ctx: any;
  private config: FetchH2ClientConfig;

  constructor(config: FetchH2ClientConfig = {}) {
    this.config = {
      rejectUnauthorized: false,
      ...config,
    };

    // Create a context with custom settings
    const contextOptions: any = {
      // Accept self-signed certificates
      overwriteUserAgent: false,
      userAgent: 'fetch-h2-client/1.0',
      // Pass TLS options to accept self-signed certificates
      session: {
        rejectUnauthorized: this.config.rejectUnauthorized,
      },
    };

    this.ctx = context(contextOptions);
  }

  async request(url: string): Promise<ClientResponse> {
    const response = await this.ctx.fetch(url);

    const body = await response.text();

    // Extract headers - fetch-h2 uses a GuardedHeaders object with entries() method
    const headers: Record<string, string> = {};
    if (response.headers) {
      // fetch-h2 uses headers.raw() to get all headers (returns object with array values)
      if (typeof response.headers.raw === 'function') {
        const rawHeaders = response.headers.raw();
        for (const [key, values] of Object.entries(rawHeaders)) {
          // Headers are arrays in raw(), take the first value
          headers[key] = Array.isArray(values) ? values[0] : String(values);
        }
      } else if (typeof response.headers.entries === 'function') {
        // Use entries() iterator for GuardedHeaders
        for (const [key, value] of response.headers.entries()) {
          headers[key] = value;
        }
      } else if (typeof response.headers.forEach === 'function') {
        // Fallback to forEach if available
        response.headers.forEach((value: string, key: string) => {
          headers[key] = value;
        });
      } else {
        // Fallback to plain object
        Object.assign(headers, response.headers);
      }
    }

    // Convert httpVersion number to string format (e.g., 2 -> '2.0')
    let httpVersion = response.httpVersion || '2.0';
    if (typeof httpVersion === 'number') {
      httpVersion = httpVersion === 2 ? '2.0' : String(httpVersion);
    }

    return {
      statusCode: response.status,
      headers,
      body,
      httpVersion,
    };
  }

  async multipleRequests(url: string, count: number): Promise<ClientResponse[]> {
    const requests: Promise<ClientResponse>[] = [];

    for (let i = 0; i < count; i++) {
      requests.push(this.request(url));
    }

    return Promise.all(requests);
  }

  async disconnect(): Promise<void> {
    await this.ctx.disconnectAll();
  }

  static async disconnectAll(): Promise<void> {
    await disconnectAll();
  }
}
