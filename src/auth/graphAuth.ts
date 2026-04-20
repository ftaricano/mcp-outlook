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
    if (this.accessToken && this.tokenExpiresAt && this.tokenExpiresAt > new Date()) {
      return this.accessToken;
    }
    
    try {
      this.ensureConfigured();
      
      const clientCredentialRequest: ClientCredentialRequest = {
        scopes: this.config!.scopes,
      };

      const response = await this.msalInstance!.acquireTokenByClientCredential(clientCredentialRequest);
      
      if (!response || !response.accessToken) {
        throw new Error('Falha ao obter token de acesso');
      }

      this.accessToken = response.accessToken;
      this.tokenExpiresAt = response.expiresOn || new Date(Date.now() + 3600000); // 1 hora como fallback

      return this.accessToken;
    } catch (error) {
      throw new Error(`Falha na autenticação: ${error instanceof Error ? error.message : 'Erro desconhecido'}`);
    }
  }

  getGraphClient(): Client {
    return Client.initWithMiddleware({
      authProvider: this
    });
  }

  async validateConnection(): Promise<boolean> {
    try {
      this.ensureConfigured();
      const client = this.getGraphClient();
      // Para Client Credentials flow, testamos com um endpoint que funciona para aplicações
      await client.api('/users').top(1).get();
      
      return true;
    } catch (error) {
      return false;
    }
  }

  private ensureConfigured(): void {
    if (this.configError) {
      throw this.configError;
    }

    if (!this.config || !this.msalInstance) {
      throw new Error('Configuração do Microsoft Graph não inicializada');
    }
  }
}
