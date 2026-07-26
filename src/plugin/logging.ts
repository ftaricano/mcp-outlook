const NOOP = (): void => {};

export function installPluginConsoleGuard(): void {
  console.debug = NOOP;
  console.info = NOOP;
  console.log = NOOP;
  console.warn = NOOP;
  console.error = NOOP;
}
