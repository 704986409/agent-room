import { createConnection } from 'node:net';
import type { RedisCommandClient } from './search-session-store.js';

type RedisValue = string | number | null | RedisValue[];

function encodeCommand(command: readonly string[]): Buffer {
  const chunks = [`*${command.length}\r\n`];
  for (const item of command) {
    const value = Buffer.from(item, 'utf8');
    chunks.push(`$${value.length}\r\n`, value.toString('binary'), '\r\n');
  }
  return Buffer.from(chunks.join(''), 'binary');
}

function parseLine(buffer: Buffer, offset: number): { line: string; next: number } | null {
  const end = buffer.indexOf('\r\n', offset, 'binary');
  if (end < 0) return null;
  return { line: buffer.toString('binary', offset, end), next: end + 2 };
}

function parseValue(buffer: Buffer, offset: number): { value: RedisValue; next: number } | null {
  if (offset >= buffer.length) return null;
  const prefix = String.fromCharCode(buffer[offset]!);
  const line = parseLine(buffer, offset + 1);
  if (!line) return null;
  if (prefix === '+') return { value: Buffer.from(line.line, 'binary').toString('utf8'), next: line.next };
  if (prefix === '-') throw new Error(`Redis command failed: ${Buffer.from(line.line, 'binary').toString('utf8')}`);
  if (prefix === ':') return { value: Number(line.line), next: line.next };
  if (prefix === '$') {
    const length = Number(line.line);
    if (length === -1) return { value: null, next: line.next };
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid Redis bulk response length.');
    if (buffer.length < line.next + length + 2) return null;
    return {
      value: buffer.toString('utf8', line.next, line.next + length),
      next: line.next + length + 2,
    };
  }
  if (prefix === '*') {
    const length = Number(line.line);
    if (length === -1) return { value: null, next: line.next };
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid Redis array response length.');
    const values: RedisValue[] = [];
    let next = line.next;
    for (let index = 0; index < length; index += 1) {
      const item = parseValue(buffer, next);
      if (!item) return null;
      values.push(item.value);
      next = item.next;
    }
    return { value: values, next };
  }
  throw new Error('Unsupported Redis response protocol.');
}

/** Small dependency-free RESP2 client for redis:// URLs and local integration tests. */
export class RedisUrlCommandClient implements RedisCommandClient {
  private readonly url: URL;
  private readonly database: number;

  constructor(connectionString: string, private readonly timeoutMs = 3000) {
    this.url = new URL(connectionString);
    if (this.url.protocol !== 'redis:') throw new TypeError('Redis connection must use redis://.');
    this.database = this.url.pathname.length > 1 ? Number(this.url.pathname.slice(1)) : 0;
    if (!Number.isInteger(this.database) || this.database < 0) throw new TypeError('Invalid Redis database number.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid Redis timeout.');
  }

  async sendCommand(command: readonly string[]): Promise<unknown> {
    if (!command.length || command.some(part => typeof part !== 'string')) {
      throw new TypeError('A Redis command is required.');
    }
    const commands: string[][] = [];
    if (this.url.password) {
      commands.push(this.url.username
        ? ['AUTH', decodeURIComponent(this.url.username), decodeURIComponent(this.url.password)]
        : ['AUTH', decodeURIComponent(this.url.password)]);
    }
    if (this.database !== 0) commands.push(['SELECT', String(this.database)]);
    commands.push([...command]);

    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.url.hostname, port: Number(this.url.port || 6379) });
      let buffer = Buffer.alloc(0);
      let parsedCount = 0;
      let lastValue: RedisValue;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(lastValue);
      };

      socket.setTimeout(this.timeoutMs, () => finish(new Error('Redis command timed out.')));
      socket.on('error', error => finish(error));
      socket.on('connect', () => {
        socket.write(Buffer.concat(commands.map(encodeCommand)));
      });
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (parsedCount < commands.length) {
          const parsed = parseValue(buffer, 0);
          if (!parsed) break;
          lastValue = parsed.value;
          parsedCount += 1;
          buffer = buffer.subarray(parsed.next);
        }
        if (parsedCount === commands.length) finish();
      });
    });
  }
}
