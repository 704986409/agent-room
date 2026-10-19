/** Values shorter than this are ignored so room codes and flags are not wiped. */
const MIN_SECRET_LENGTH = 8;

export class SecretRegistry {
  private readonly values = new Set<string>();

  add(value: string | undefined): void {
    if (value && value.length >= MIN_SECRET_LENGTH) this.values.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.values) out = out.split(secret).join('[redacted]');
    out = out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    out = out.replace(/ar_session=[^;\s]+/g, 'ar_session=[redacted]');
    return out;
  }
}
