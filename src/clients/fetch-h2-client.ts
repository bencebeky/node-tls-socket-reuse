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
    };

    this.ctx = context(contextOptions);
  }

  async request(url: string): Promise<ClientResponse> {
    const response = await this.ctx.fetch(url);

    const body = await response.text();

    // Extract headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value: string, key: string) => {
      headers[key] = value;
    });

    return {
      statusCode: response.status,
      headers,
      body,
      httpVersion: response.httpVersion || '2.0',
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

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new FetchH2Client();

  try {
    console.log('Making request with fetch-h2...');
    const response = await client.request('https://localhost:8443/test');

    console.log('Status:', response.statusCode);
    console.log('HTTP Version:', response.httpVersion);
    console.log('Headers:', response.headers);
    console.log('Body:', response.body);

    console.log('\nMaking 3 sequential requests...');
    const responses = await client.multipleRequests('https://localhost:8443/test', 3);
    console.log(`Completed ${responses.length} requests`);

    await client.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}
