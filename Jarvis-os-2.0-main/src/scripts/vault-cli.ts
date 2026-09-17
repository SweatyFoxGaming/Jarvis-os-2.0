import { SecretVault } from '../security/secret-vault.js';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npx tsx src/scripts/vault-cli.ts <SECRET_TO_ENCRYPT>');
  process.exit(1);
}

const vault = new SecretVault();
console.log('Encrypted Value:', vault.encrypt(input));