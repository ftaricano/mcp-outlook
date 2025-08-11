#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

import { GraphAuthProvider } from './dist/auth/graphAuth.js';

async function testConnection() {
  try {
    console.log('🔑 Testando autenticação com Microsoft Graph...');
    
    const authProvider = new GraphAuthProvider();
    const token = await authProvider.getAccessToken();
    
    console.log('✅ Token obtido com sucesso!');
    console.log(`Token (primeiros 20 chars): ${token.substring(0, 20)}...`);
    
    console.log('\n🔗 Testando conexão com Microsoft Graph...');
    const isValid = await authProvider.validateConnection();
    
    if (isValid) {
      console.log('✅ Conexão com Microsoft Graph funcionando!');
      console.log('\n🎉 Seu MCP server está pronto para uso!');
    } else {
      console.log('❌ Falha na conexão com Microsoft Graph');
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    
    if (error.message.includes('Variáveis de ambiente')) {
      console.log('\n📝 Certifique-se de que o arquivo .env está configurado corretamente');
    } else if (error.message.includes('AADSTS')) {
      console.log('\n🔧 Possíveis soluções:');
      console.log('• Verifique se as credenciais no .env estão corretas');
      console.log('• Confirme que as permissões foram concedidas no Azure Portal');
      console.log('• Verifique se o client secret não expirou');
    }
  }
}

testConnection();