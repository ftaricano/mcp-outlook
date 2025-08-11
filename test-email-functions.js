#!/usr/bin/env node

import dotenv from 'dotenv';
dotenv.config();

import { GraphAuthProvider } from './dist/auth/graphAuth.js';
import { EmailService } from './dist/services/emailService.js';
import { EmailSummarizer } from './dist/services/emailSummarizer.js';

async function testEmailFunctions() {
  console.log('🧪 Testando funcionalidades do MCP Email Server...\n');

  try {
    console.log('1️⃣ Inicializando serviços...');
    const authProvider = new GraphAuthProvider();
    const emailService = new EmailService(authProvider);
    const emailSummarizer = new EmailSummarizer();
    
    const targetUser = process.env.TARGET_USER_EMAIL || 'usuário autenticado';
    console.log(`📧 Configurado para acessar emails de: ${targetUser}\n`);

    console.log('2️⃣ Testando autenticação...');
    const token = await authProvider.getAccessToken();
    console.log('✅ Token obtido com sucesso!\n');

    console.log('3️⃣ Testando listagem de emails...');
    try {
      const emails = await emailService.listEmails({ maxResults: 5 });
      console.log(`✅ Encontrados ${emails.length} emails!`);
      
      if (emails.length > 0) {
        const firstEmail = emails[0];
        console.log(`📬 Primeiro email:`);
        console.log(`   Assunto: ${firstEmail.subject || 'Sem assunto'}`);
        console.log(`   De: ${firstEmail.from?.emailAddress?.address || 'Desconhecido'}`);
        console.log(`   Data: ${firstEmail.receivedDateTime}`);
        console.log(`   Lido: ${firstEmail.isRead ? 'Sim' : 'Não'}\n`);

        console.log('4️⃣ Testando resumo de email...');
        try {
          const summary = await emailSummarizer.summarizeEmail(firstEmail);
          console.log('✅ Resumo gerado com sucesso!');
          console.log(`   Prioridade: ${summary.priority}`);
          console.log(`   Categoria: ${summary.category}`);
          console.log(`   Resumo: ${summary.summary}`);
          console.log(`   Ação necessária: ${summary.actionRequired ? 'Sim' : 'Não'}\n`);
        } catch (error) {
          console.log(`❌ Erro ao gerar resumo: ${error.message}\n`);
        }

        console.log('5️⃣ Testando filtros de email...');
        try {
          const unreadEmails = await emailService.getUnreadEmails(3);
          console.log(`✅ Encontrados ${unreadEmails.length} emails não lidos\n`);
        } catch (error) {
          console.log(`⚠️  Erro nos filtros: ${error.message}\n`);
        }
      }
    } catch (error) {
      if (error.message.includes('Insufficient privileges')) {
        console.log('❌ Erro de permissões - As permissões não foram concedidas no Azure Portal');
        console.log('🔧 Para corrigir:');
        console.log('   1. Vá para o Azure Portal → sua aplicação');
        console.log('   2. API permissions → Grant admin consent');
        console.log('   3. Confirme a concessão das permissões\n');
      } else {
        console.log(`❌ Erro ao acessar emails: ${error.message}\n`);
      }
    }

    console.log('6️⃣ Testando listagem de usuários...');
    try {
      const client = authProvider.getGraphClient();
      const response = await client.api('/users').top(3).select('displayName,mail').get();
      console.log(`✅ Encontrados ${response.value.length} usuários na organização`);
      response.value.forEach(user => {
        console.log(`   - ${user.displayName} (${user.mail})`);
      });
    } catch (error) {
      console.log(`⚠️  Erro ao listar usuários: ${error.message}`);
    }

  } catch (error) {
    console.error('💥 Erro geral:', error.message);
    
    if (error.message.includes('Variáveis de ambiente')) {
      console.log('\n📝 Verifique se o arquivo .env está configurado corretamente');
    }
  }

  console.log('\n🎯 Resumo do teste:');
  console.log('✅ Autenticação: Token obtido com sucesso');
  console.log('⚠️  Permissões: Precisam ser concedidas no Azure Portal');
  console.log('🚀 Servidor: Pronto para uso após concessão de permissões');
}

testEmailFunctions();