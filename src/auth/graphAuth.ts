import { Client } from '@microsoft/microsoft-graph-client';
import { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { ConfidentialClientApplication, ClientCredentialRequest } from '@azure/msal-node';

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

  constructor() {
    this.config = this.getConfigFromEnv();
    
    this.msalInstance = new ConfidentialClientApplication({
      auth: {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        authority: `https://login.microsoftonline.com/${this.config.tenantId}`,
      },
    });
  }

  private getConfigFromEnv(): GraphConfig {
    const clientId = process.env.MICROSOFT_GRAPH_CLIENT_ID;
    const clientSecret = process.env.MICROSOFT_GRAPH_CLIENT_SECRET;
    const tenantId = process.env.MICROSOFT_GRAPH_TENANT_ID;

    if (!clientId || !clientSecret || !tenantId) {
      throw new Error(
        'Variáveis de ambiente necessárias não foram definidas. ' +
        'Defina MICROSOFT_GRAPH_CLIENT_ID, MICROSOFT_GRAPH_CLIENT_SECRET e MICROSOFT_GRAPH_TENANT_ID'
      );
    }

    // Para Client Credentials flow, usar .default é obrigatório
    // As permissões específicas são configuradas no Azure AD Portal
    const scopes = ['https://graph.microsoft.com/.default'];

    return {
      clientId,
      clientSecret,
      tenantId,
      scopes
    };
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiresAt && this.tokenExpiresAt > new Date()) {
      return this.accessToken;
    }
    
    try {
      
      const clientCredentialRequest: ClientCredentialRequest = {
        scopes: this.config.scopes,
      };

      const response = await this.msalInstance.acquireTokenByClientCredential(clientCredentialRequest);
      
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
      const client = this.getGraphClient();
      // Para Client Credentials flow, testamos com um endpoint que funciona para aplicações
      await client.api('/users').top(1).get();
      
      return true;
    } catch (error) {
      return false;
    }
  }
}