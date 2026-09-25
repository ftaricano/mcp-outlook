import type { PluginConfig } from './config.js';

/**
 * Warnings printed to stderr when the plugin starts. They never change what the
 * plugin does; they point at configuration that is allowed today but unsafe.
 */
export function pluginStartupWarnings(
  config: Pick<PluginConfig, 'allowSend'>,
  env: { readonly OUTLOOK_ALLOWED_RECIPIENT_DOMAINS?: string }
): string[] {
  const warnings: string[] = [];
  // The send gate pins the sender, but recipients come from the caller, and the
  // caller is steered by untrusted mail. Without a recipient allowlist a
  // prompt-injected message can have its contents sent anywhere.
  if (config.allowSend && !env.OUTLOOK_ALLOWED_RECIPIENT_DOMAINS?.trim()) {
    warnings.push(
      'PLUGIN_ALLOW_SEND=true without OUTLOOK_ALLOWED_RECIPIENT_DOMAINS: send_email can reach any ' +
        'recipient. Set it to the domains you expect to write to; a future major release will ' +
        "default it to the sending mailbox's domain."
    );
  }
  return warnings;
}
