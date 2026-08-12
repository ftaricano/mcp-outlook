import { GraphAuthProvider } from '../auth/graphAuth.js';
import type { AppEnv } from '../config/env.js';
import { createPathGuard } from '../security/pathGuard.js';
import { EmailService } from '../services/emailService.js';
import { loadPluginConfig, type PluginConfig } from './config.js';
import { MultiMailboxService } from './MultiMailboxService.js';
import { loadSearchMemory } from './searchMemory.js';

export interface OutlookPluginRuntime {
  readonly config: PluginConfig;
  readonly service: MultiMailboxService;
  validateGraphConnection(): Promise<boolean>;
}

export function createOutlookPluginRuntime(
  env: AppEnv,
  configPath = process.env.OUTLOOK_PLUGIN_CONFIG
): OutlookPluginRuntime {
  const config = loadPluginConfig(configPath);
  const authProvider = new GraphAuthProvider(env);
  const pathGuard = createPathGuard();
  const services = new Map<string, EmailService>();
  const searchMemory = loadSearchMemory(config.searchMemoryPath);

  const service = new MultiMailboxService(
    config,
    (mailboxAddress) => {
      const existing = services.get(mailboxAddress);
      if (existing) return existing;

      const created = new EmailService(authProvider, pathGuard, {
        targetUserEmail: mailboxAddress,
        preloadCache: false,
        ensureDownloadDirectory: false,
      });
      services.set(mailboxAddress, created);
      return created;
    },
    searchMemory
  );

  return {
    config,
    service,
    validateGraphConnection: () => authProvider.validateConnection(),
  };
}
