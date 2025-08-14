import { EmailService } from './dist/services/emailService.js';
import { GraphAuthProvider } from './dist/auth/graphAuth.js';
import dotenv from 'dotenv';

// Carregar variáveis de ambiente
dotenv.config();

async function testHybridFunction() {
  try {
    console.log('🧪 Testando função híbrida...');
    
    // Configurar autenticação
    const authProvider = new GraphAuthProvider(
      process.env.MICROSOFT_GRAPH_CLIENT_ID,
      process.env.MICROSOFT_GRAPH_CLIENT_SECRET,
      process.env.MICROSOFT_GRAPH_TENANT_ID
    );
    
    const emailService = new EmailService(authProvider);
    
    // Testar função sendEmailWithFileAttachment
    const filePath = '/Users/fernandotaricano/Downloads/mcp-email-attachments/RptClienteLista_Quiver.xlsx';
    const to = ['fernando.taricano@cpzseg.com.br'];
    const subject = '🎉 Teste da Nova Função Híbrida - Relatório Quiver';
    const body = `
Olá Fernando,

Testando a nova função híbrida que resolve completamente as limitações do MCP!

**Método usado:** sendEmailWithFileAttachment
- ✅ Lê arquivo diretamente do disco
- ✅ Codifica internamente sem limitações MCP  
- ✅ Envia com qualquer tamanho de arquivo

**Arquivo anexado:**
- Nome: RptClienteLista_Quiver.xlsx
- Tamanho: 297KB
- Tipo: Planilha Excel

Esta nova função permite automação completa de emails com anexos grandes!

Atenciosamente,
Sistema MCP - Teste de Funcionalidade Híbrida
    `;
    
    console.log('📧 Enviando email com arquivo híbrido...');
    
    const result = await emailService.sendEmailWithFileAttachment(
      filePath,
      to,
      subject,
      body,
      {
        enhancedOptions: {
          useTemplate: true,
          templateOptions: { theme: 'modern' }
        }
      }
    );
    
    if (result.success) {
      console.log('✅ Sucesso!');
      console.log('📊 Detalhes:', result.attachmentInfo);
    } else {
      console.log('❌ Falha:', result.error);
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
  }
}

testHybridFunction();