import { Client } from '@microsoft/microsoft-graph-client';
import { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { ConfidentialClientApplication, ClientCredentialRequest } from '@azure/msal-node';
import { AppEnv } from '../config/env.js';

interface GraphConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  scopes: string[];
}

export class GraphAuthProvider implements AuthenticationProvider {
  private msalInstance: ConfidentialClientApplication;
  private config: GraphConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;

  constructor(env: AppEnv) {
    this.config = {
      clientId: env.MICROSOFT_GRAPH_CLIENT_ID,
      clientSecret: env.MICROSOFT_GRAPH_CLIENT_SECRET,
      tenantId: env.MICROSOFT_GRAPH_TENANT_ID,
      scopes: ['https://graph.microsoft.com/.default'],
    };
    this.msalInstance = new ConfidentialClientApplication({
      auth: {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        authority: `https://login.microsoftonline.com/${this.config.tenantId}`,
      },
    });
  }

  async getAccessToken(): Promise<string> {
    // Refresh 60s before actual expiry to avoid racing Graph with a stale token.
    const now = Date.now();
    const refreshThreshold = 60_000;
    if (
      this.accessToken &&
      this.tokenExpiresAt &&
      this.tokenExpiresAt.getTime() - now > refreshThreshold
    ) {
      return this.accessToken;
    }

    try {
      const request: ClientCredentialRequest = { scopes: this.config.scopes };
      const response = await this.msalInstance.acquireTokenByClientCredential(request);

      if (!response?.accessToken) {
        throw new Error('MSAL did not return an access token');
      }

      this.accessToken = response.accessToken;
      this.tokenExpiresAt = response.expiresOn ?? new Date(now + 3_600_000);
      return this.accessToken;
    } catch (error) {
      throw new Error(
        `Authentication failed: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  }

  getGraphClient(): Client {
    return Client.initWithMiddleware({ authProvider: this });
  }

  /**
   * Validate that the credentials resolve to a working Graph token.
   * Returns true only if token acquisition succeeds. Avoids the previous
   * `/users` top(1) probe which required `User.Read.All` even when the
   * caller only needs Mail permissions.
   */
  async validateConnection(): Promise<boolean> {
    try {
      await this.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }
}
