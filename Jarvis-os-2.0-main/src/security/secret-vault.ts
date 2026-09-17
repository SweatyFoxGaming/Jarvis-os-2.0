export class SecretVault {
  private secrets: Map<string, string> = new Map();

  async getSecret(key: string): Promise<string | undefined> {
    return this.secrets.get(key) || process.env[key];
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
  }

  encrypt(value: string): string {
    return Buffer.from(value).toString('base64');
  }

  decrypt(value: string): string {
    return Buffer.from(value, 'base64').toString('utf-8');
  }
}
