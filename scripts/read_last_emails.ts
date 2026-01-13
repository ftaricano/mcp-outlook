
import dotenv from 'dotenv';
import path from 'path';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carregar .env da raiz
dotenv.config({ path: path.join(__dirname, '../.env') });

import { GraphAuthProvider } from '../src/auth/graphAuth.js';
import { EmailService } from '../src/services/emailService.js';

async function main() {
  try {
    console.log('Autenticando...');
    const authProvider = new GraphAuthProvider();
    // Validar conexão antes de instanciar service, similar ao index.ts (boa prática)
    await authProvider.validateConnection();
    console.log('Conexão validada.');

    const emailService = new EmailService(authProvider);

    console.log('Buscando últimos 4 emails...');
    const emails = await emailService.listEmails({ maxResults: 4 });

    if (!emails || emails.length === 0) {
      console.log('Nenhum email encontrado.');
      return;
    }

    console.log(`\nEncontrados ${emails.length} emails:\n`);
    
    emails.forEach((email, index) => {
      console.log(`--- Email ${index + 1} ---`);
      console.log(`Data: ${email.receivedDateTime}`);
      console.log(`De: ${email.from?.emailAddress?.address}`);
      console.log(`Assunto: ${email.subject}`);
      // Tratar bodyPreview que pode ser null/undefined
      const preview = email.bodyPreview || '';
      console.log(`Preview: ${preview.substring(0, 100).replace(/\n/g, ' ')}...`);
      console.log('');
    });

  } catch (error) {
    console.error('Erro ao ler emails:', error);
    if (error instanceof Error) {
        console.error('Stack:', error.stack);
    }
  }
}

main();
