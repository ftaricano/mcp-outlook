import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * FileManager - Gerencia downloads e salvamento de arquivos grandes
 * Otimizado para trabalhar com anexos do Microsoft Graph via MCP
 */
export class FileManager {
  private downloadDir: string;
  
  constructor(customDownloadDir?: string) {
    // Usar diretório personalizado ou criar um padrão
    this.downloadDir = customDownloadDir || path.join(os.homedir(), 'Downloads', 'mcp-email-attachments');
    this.ensureDownloadDirectory();
  }

  /**
   * Garante que o diretório de downloads existe
   */
  private ensureDownloadDirectory(): void {
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
      console.error(`📁 Diretório criado: ${this.downloadDir}`);
    }
  }

  /**
   * Salva um arquivo de forma otimizada, evitando manter todo o conteúdo em memória
   */
  async saveAttachmentToDisk(
    attachment: {
      name: string;
      contentType: string;
      contentBytes: string;
      size: number;
      id?: string;
    },
    options: {
      filename?: string;
      overwrite?: boolean;
      validateIntegrity?: boolean;
      targetDirectory?: string;
    } = {}
  ): Promise<{
    success: boolean;
    filePath: string;
    originalSize: number;
    savedSize: number;
    integrity: boolean;
    error?: string;
  }> {
    try {
      // Determinar diretório de destino
      const targetDir = options.targetDirectory || this.downloadDir;
      this.ensureDirectoryExists(targetDir);

      // Determinar nome do arquivo
      const filename = options.filename || this.sanitizeFilename(attachment.name);
      const filePath = path.join(targetDir, filename);

      // Verificar se arquivo já existe
      if (fs.existsSync(filePath) && !options.overwrite) {
        const timestamp = Date.now();
        const ext = path.extname(filename);
        const nameWithoutExt = path.basename(filename, ext);
        const newFilename = `${nameWithoutExt}_${timestamp}${ext}`;
        return this.saveAttachmentToDisk(attachment, {
          ...options, 
          filename: newFilename,
          targetDirectory: targetDir 
        });
      }

      console.error('💾 Iniciando salvamento otimizado...');
      console.error(`   Arquivo: ${filename}`);
      console.error(`   Tamanho original: ${attachment.size} bytes`);
      console.error(`   Destino: ${filePath}`);

      // Processar Base64 em chunks para evitar problemas de memória
      const result = await this.saveBase64ToFileOptimized(
        attachment.contentBytes, 
        filePath, 
        attachment.size
      );

      // Validação de integridade opcional
      let integrity = true;
      if (options.validateIntegrity) {
        integrity = await this.validateFileIntegrity(filePath, attachment.size);
        console.error(`🔍 Integridade: ${integrity ? '✅ OK' : '❌ FALHA'}`);
      }

      return {
        success: result.success,
        filePath,
        originalSize: attachment.size,
        savedSize: result.fileSize,
        integrity,
        error: result.error
      };

    } catch (error) {
      console.error('❌ Erro no FileManager:', error);
      return {
        success: false,
        filePath: '',
        originalSize: attachment.size,
        savedSize: 0,
        integrity: false,
        error: error instanceof Error ? error.message : 'Erro desconhecido'
      };
    }
  }

  /**
   * Salva Base64 para arquivo de forma otimizada usando streams
   */
  private async saveBase64ToFileOptimized(
    base64Content: string,
    filePath: string,
    _expectedSize: number
  ): Promise<{ success: boolean; fileSize: number; error?: string }> {
    return new Promise((resolve) => {
      try {
        // Criar stream de escrita
        const writeStream = fs.createWriteStream(filePath);
        
        writeStream.on('error', (error) => {
          console.error('❌ Erro no stream de escrita:', error);
          resolve({ success: false, fileSize: 0, error: error.message });
        });

        writeStream.on('finish', () => {
          // Verificar tamanho final
          const stats = fs.statSync(filePath);
          console.error(`✅ Arquivo salvo: ${stats.size} bytes`);
          resolve({ success: true, fileSize: stats.size });
        });

        // Processar Base64 em chunks para evitar sobrecarga de memória
        const chunkSize = 8192; // 8KB chunks
        let offset = 0;

        const processChunk = () => {
          if (offset >= base64Content.length) {
            writeStream.end();
            return;
          }

          const chunk = base64Content.slice(offset, offset + chunkSize);
          const buffer = Buffer.from(chunk, 'base64');
          
          writeStream.write(buffer, (error) => {
            if (error) {
              console.error('❌ Erro ao escrever chunk:', error);
              writeStream.destroy();
              resolve({ success: false, fileSize: 0, error: error.message });
              return;
            }
            
            offset += chunkSize;
            // Processar próximo chunk de forma assíncrona
            setImmediate(processChunk);
          });
        };

        // Iniciar processamento
        processChunk();

      } catch (error) {
        console.error('❌ Erro na conversão Base64:', error);
        resolve({ 
          success: false, 
          fileSize: 0, 
          error: error instanceof Error ? error.message : 'Erro na conversão' 
        });
      }
    });
  }

  /**
   * Valida a integridade do arquivo salvo
   */
  private async validateFileIntegrity(filePath: string, expectedSize: number): Promise<boolean> {
    try {
      const stats = fs.statSync(filePath);
      const actualSize = stats.size;
      
      // Tolerância de 5% para diferenças de encoding
      const tolerance = Math.max(1000, expectedSize * 0.05);
      const sizeDifference = Math.abs(actualSize - expectedSize);
      
      const isValid = sizeDifference <= tolerance;
      
      if (!isValid) {
        console.warn(`⚠️  Diferença de tamanho: esperado ${expectedSize}, atual ${actualSize} (diferença: ${sizeDifference})`);
      }
      
      return isValid;
    } catch (error) {
      console.error('❌ Erro na validação:', error);
      return false;
    }
  }

  /**
   * Sanitiza nome do arquivo removendo caracteres inválidos
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[<>:"/\\|?*]/g, '_')  // Caracteres inválidos
      .replace(/\s+/g, '_')           // Espaços múltiplos
      .replace(/_{2,}/g, '_')         // Underscores múltiplos
      .replace(/^_+|_+$/g, '')        // Underscores no início/fim
      .slice(0, 255);                 // Limitar tamanho
  }

  /**
   * Garante que um diretório existe
   */
  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Lista arquivos baixados
   */
  listDownloadedFiles(): Array<{
    name: string;
    path: string;
    size: number;
    modified: Date;
  }> {
    try {
      if (!fs.existsSync(this.downloadDir)) {
        return [];
      }

      const files = fs.readdirSync(this.downloadDir)
        .map(filename => {
          const filePath = path.join(this.downloadDir, filename);
          const stats = fs.statSync(filePath);
          
          return {
            name: filename,
            path: filePath,
            size: stats.size,
            modified: stats.mtime
          };
        })
        .filter(file => fs.statSync(file.path).isFile())
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());

      return files;
    } catch (error) {
      console.error('❌ Erro ao listar arquivos:', error);
      return [];
    }
  }

  /**
   * Limpa arquivos antigos
   */
  cleanupOldFiles(maxAgeHours: number = 24): number {
    try {
      const files = this.listDownloadedFiles();
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      let cleanedCount = 0;

      for (const file of files) {
        if (file.modified.getTime() < cutoffTime) {
          fs.unlinkSync(file.path);
          cleanedCount++;
          console.error(`🗑️  Removido arquivo antigo: ${file.name}`);
        }
      }

      return cleanedCount;
    } catch (error) {
      console.error('❌ Erro na limpeza:', error);
      return 0;
    }
  }

  /**
   * Obtém informações sobre o diretório de downloads
   */
  getDownloadDirInfo(): {
    path: string;
    exists: boolean;
    fileCount: number;
    totalSize: number;
  } {
    const files = this.listDownloadedFiles();
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    return {
      path: this.downloadDir,
      exists: fs.existsSync(this.downloadDir),
      fileCount: files.length,
      totalSize
    };
  }

  /**
   * Codifica um arquivo do sistema de arquivos para base64 para uso como anexo de email
   * Esta função resolve o problema de anexos chegando com 0KB
   */
  async encodeFileForEmailAttachment(filePath: string): Promise<{
    success: boolean;
    name: string;
    contentType: string;
    content: string; // Base64 encoded
    size: number;
    error?: string;
  }> {
    try {
      console.error(`📎 Codificando arquivo para anexo: ${filePath}`);

      // 1. Verificar se arquivo existe
      if (!fs.existsSync(filePath)) {
        throw new Error(`Arquivo não encontrado: ${filePath}`);
      }

      // 2. Obter informações do arquivo
      const stats = fs.statSync(filePath);
      const fileSize = stats.size;
      const fileName = path.basename(filePath);

      console.error(`   Nome: ${fileName}`);
      console.error(`   Tamanho: ${(fileSize / 1024).toFixed(1)}KB`);

      // 3. Verificar tamanho (limite de 15MB para Microsoft Graph)
      const maxSize = 15 * 1024 * 1024; // 15MB
      if (fileSize > maxSize) {
        throw new Error(`Arquivo muito grande: ${(fileSize / (1024 * 1024)).toFixed(2)}MB. Limite: 15MB`);
      }

      // 4. Detectar MIME type baseado na extensão
      const contentType = this.detectContentType(filePath);
      console.error(`   Tipo MIME: ${contentType}`);

      // 5. Ler e codificar arquivo
      console.error('🔄 Lendo e codificando arquivo...');
      const fileBuffer = fs.readFileSync(filePath);
      const base64Content = fileBuffer.toString('base64');

      // 6. Validar codificação
      const decodedSize = Buffer.from(base64Content, 'base64').length;
      if (decodedSize !== fileSize) {
        console.warn(`⚠️  Diferença de tamanho após codificação: original=${fileSize}, decodificado=${decodedSize}`);
      }

      console.error(`✅ Arquivo codificado com sucesso`);
      console.error(`   Base64 length: ${base64Content.length} caracteres`);
      console.error(`   Tamanho decodificado: ${decodedSize} bytes`);

      return {
        success: true,
        name: fileName,
        contentType,
        content: base64Content,
        size: fileSize
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Erro desconhecido';
      console.error(`❌ Erro ao codificar arquivo: ${errorMessage}`);
      
      return {
        success: false,
        name: '',
        contentType: '',
        content: '',
        size: 0,
        error: errorMessage
      };
    }
  }

  /**
   * Detecta o tipo MIME baseado na extensão do arquivo
   */
  private detectContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    
    const mimeTypes: { [key: string]: string } = {
      // Documentos
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.txt': 'text/plain',
      '.rtf': 'application/rtf',
      
      // Imagens
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      
      // Arquivos comprimidos
      '.zip': 'application/zip',
      '.rar': 'application/x-rar-compressed',
      '.7z': 'application/x-7z-compressed',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      
      // Áudio e vídeo
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.mp4': 'video/mp4',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      
      // Email
      '.eml': 'message/rfc822',
      '.msg': 'application/vnd.ms-outlook',
      
      // Desenvolvimento
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.csv': 'text/csv',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.ts': 'application/typescript'
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Valida se um arquivo pode ser usado como anexo de email
   */
  validateFileForAttachment(filePath: string): {
    valid: boolean;
    error?: string;
    warnings: string[];
  } {
    const warnings: string[] = [];
    
    try {
      // 1. Verificar existência
      if (!fs.existsSync(filePath)) {
        return { valid: false, error: `Arquivo não encontrado: ${filePath}`, warnings };
      }

      // 2. Verificar se é arquivo (não diretório)
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return { valid: false, error: 'Caminho especificado não é um arquivo', warnings };
      }

      // 3. Verificar tamanho
      const fileSize = stats.size;
      const maxSize = 15 * 1024 * 1024; // 15MB
      
      if (fileSize === 0) {
        return { valid: false, error: 'Arquivo está vazio (0 bytes)', warnings };
      }
      
      if (fileSize > maxSize) {
        return { 
          valid: false, 
          error: `Arquivo muito grande: ${(fileSize / (1024 * 1024)).toFixed(2)}MB. Limite: 15MB`, 
          warnings 
        };
      }

      // 4. Avisos baseados no tamanho
      if (fileSize > 1024 * 1024) { // 1MB
        warnings.push(`Arquivo grande: ${(fileSize / (1024 * 1024)).toFixed(2)}MB - pode demorar para processar`);
      }

      // 5. Avisos baseados na extensão
      const ext = path.extname(filePath).toLowerCase();
      const executableExtensions = ['.exe', '.bat', '.cmd', '.scr', '.com', '.pif'];
      
      if (executableExtensions.includes(ext)) {
        warnings.push('Arquivo executável pode ser bloqueado por filtros de email');
      }

      // 6. Verificar permissões de leitura
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
      } catch {
        return { valid: false, error: 'Sem permissão para ler o arquivo', warnings };
      }

      return { valid: true, warnings };

    } catch (error) {
      return { 
        valid: false, 
        error: error instanceof Error ? error.message : 'Erro ao validar arquivo', 
        warnings 
      };
    }
  }
}