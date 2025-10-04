import { Bot, Context } from 'grammy';
import { logger } from './logger.js';

export interface BotError extends Error {
  code?: string;
  statusCode?: number;
  userMessage?: string;
  isUserError?: boolean;
}

export class UserError extends Error implements BotError {
  isUserError = true;
  userMessage: string;
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.userMessage = message;
    this.code = code;
  }
}

export class ValidationError extends UserError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class WalletError extends UserError {
  constructor(message: string) {
    super(message, 'WALLET_ERROR');
  }
}

export class TradeError extends UserError {
  constructor(message: string) {
    super(message, 'TRADE_ERROR');
  }
}

export class NetworkError extends Error implements BotError {
  isUserError = false;
  userMessage = 'Network is experiencing issues. Please try again in a few minutes.';
  code = 'NETWORK_ERROR';
  statusCode = 503;

  constructor(message: string) {
    super(message);
  }
}

export function createErrorHandler() {
  return async (err: any, ctx: Context) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const message = ctx.message?.text || '';

    // Log the error with context
    logger.error({
      error: {
        name: err?.name || 'Unknown',
        message: err?.message || 'Unknown error',
        code: err?.code,
        stack: err?.stack,
      },
      context: {
        userId,
        chatId,
        message,
        isUserError: err?.isUserError || false,
      }
    }, 'Bot error occurred');

    // Determine user-facing message
    let userMessage: string;
    
    if (err?.isUserError) {
      userMessage = err.userMessage || err.message;
    } else {
      // Handle specific error types
      if (err?.message?.includes('no backend') || 
          err?.message?.includes('healthy') || 
          err?.message?.includes('timeout') ||
          err?.message?.includes('rate limit') ||
          err?.message?.includes('too many requests')) {
        userMessage = 'Network is experiencing heavy traffic. Please try again in a few minutes.';
      } else if (err?.message?.includes('insufficient funds') || 
                 err?.message?.includes('gas')) {
        userMessage = 'Insufficient funds for this transaction. Please check your ETH balance.';
      } else if (err?.message?.includes('slippage') || 
                 err?.message?.includes('price impact')) {
        userMessage = 'Price moved too much during transaction. Please try again with a smaller amount.';
      } else if (err?.message?.includes('liquidity')) {
        userMessage = 'Insufficient liquidity for this trade. Try a smaller amount or different token.';
      } else {
        userMessage = 'An unexpected error occurred. Please try again or contact support if the issue persists.';
      }
    }

    // Send error message to user
    try {
      await ctx.reply(`⚠️ ${userMessage}`);
    } catch (replyError) {
      logger.error({ replyError }, 'Failed to send error message to user');
    }

    // For non-user errors, also log additional context for debugging
    if (!err?.isUserError) {
      logger.error({
        error: err,
        context: {
          userId,
          chatId,
          message,
          timestamp: new Date().toISOString(),
        }
      }, 'Non-user error details');
    }
  };
}

export function validateEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function validatePrivateKey(pk: string): boolean {
  // Remove 0x prefix if present
  const cleanPk = pk.startsWith('0x') ? pk.slice(2) : pk;
  return /^[a-fA-F0-9]{64}$/.test(cleanPk);
}

export function validateAmount(amount: string): { isValid: boolean; value?: number; error?: string } {
  const num = parseFloat(amount);
  
  if (isNaN(num)) {
    return { isValid: false, error: 'Amount must be a valid number' };
  }
  
  if (num <= 0) {
    return { isValid: false, error: 'Amount must be greater than 0' };
  }
  
  return { isValid: true, value: num };
}

export function sanitizeInput(input: string): string {
  return input.trim().replace(/[<>]/g, '');
}
