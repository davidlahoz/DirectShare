import { startServer } from './app';
import { ConfigError, loadConfig, type ServerConfig } from './config';
import { createLogger, type LogLevel } from './log';

async function main(): Promise<void> {
  const log = createLogger((process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info');
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error('invalid_configuration', { message: err.message });
      process.exit(1);
    }
    throw err;
  }
  const running = await startServer(config, log);
  const scheme = config.tls ? 'https' : 'http';
  process.stdout.write(
    `\nDirectShare is running. Open ${scheme}://localhost:${running.port} in your browser.\n` +
      `(Inside Docker this is the container port; use the host port you published, 8080 by default.)\n\n`,
  );
  const shutdown = (signal: string) => {
    log.info('shutting_down', { signal });
    void running.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
