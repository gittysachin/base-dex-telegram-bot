import { Context } from 'grammy';
import { ValidationError, validateEthereumAddress, validatePrivateKey, validateAmount, sanitizeInput } from './errorHandler.js';

export function validateCommandInput(ctx: Context, command: string, expectedArgs: number): string[] {
  const message = ctx.message?.text;
  if (!message) {
    throw new ValidationError('Invalid message format');
  }

  const sanitized = sanitizeInput(message);
  const parts = sanitized.trim().split(/\s+/);
  
  if (parts.length !== expectedArgs + 1) { // +1 for the command itself
    throw new ValidationError(`Usage: /${command} ${getUsageMessage(command)}`);
  }

  return parts.slice(1); // Return only the arguments
}

function getUsageMessage(command: string): string {
  switch (command) {
    case 'import':
      return '<private_key_hex>';
    case 'scan':
      return '<token_address>';
    default:
      return '<arguments>';
  }
}

export function validateImportCommand(ctx: Context): string {
  const args = validateCommandInput(ctx, 'import', 1);
  const privateKey = args[0];
  
  if (!validatePrivateKey(privateKey)) {
    throw new ValidationError('Invalid private key format. Must be 64 hex characters (with or without 0x prefix)');
  }
  
  return privateKey;
}

export function validateScanCommand(ctx: Context): string {
  const args = validateCommandInput(ctx, 'scan', 1);
  const address = args[0];
  
  if (!validateEthereumAddress(address)) {
    throw new ValidationError('Invalid token address format. Must be a valid Ethereum address.');
  }
  
  return address;
}

export function validateTradeCommand(text: string): { action: 'buy' | 'sell'; amount: number } {
  const sanitized = sanitizeInput(text);
  const match = sanitized.match(/^(buy|sell)\s+([0-9]*\.?[0-9]+)$/i);
  
  if (!match) {
    throw new ValidationError('Invalid trade format. Use: buy <amount> or sell <amount>');
  }
  
  const [, action, amountStr] = match;
  const validation = validateAmount(amountStr);
  
  if (!validation.isValid) {
    throw new ValidationError(validation.error!);
  }
  
  return {
    action: action.toLowerCase() as 'buy' | 'sell',
    amount: validation.value!
  };
}

export function validateUserContext(ctx: Context): { userId: string; username?: string } {
  const userId = ctx.from?.id;
  if (!userId) {
    throw new ValidationError('Unable to identify user');
  }
  
  return {
    userId: String(userId),
    username: ctx.from?.username
  };
}
