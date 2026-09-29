/**
 * Minimal structured logger. Callers must only pass operational metadata:
 * never room ids, secrets, session ids, SDP, display names or file details.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level: LogLevel = 'info'): Logger {
  const emit = (lvl: LogLevel, event: string, fields?: LogFields) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, event, ...fields });
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
