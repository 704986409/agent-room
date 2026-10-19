import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SecretRegistry } from './redact.js';

/** In-memory daemon log plus a file. Reads are redacted with the current secret set. */
export class DaemonLog {
  private readonly lines: string[] = [];

  constructor(private readonly secrets: SecretRegistry, private readonly file?: string) {}

  write(line: string): void {
    this.lines.push(line);
    if (this.lines.length > 500) this.lines.shift();
    if (!this.file) return;
    const clean = this.secrets.redact(line);
    void mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      .then(() => appendFile(this.file!, `${clean}\n`, { mode: 0o600 }))
      .catch(() => undefined);
  }

  async tail(limit = 100): Promise<string[]> {
    return this.lines.slice(-limit).map(line => this.secrets.redact(line));
  }
}
