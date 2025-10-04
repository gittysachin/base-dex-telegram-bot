import { logger } from './logger.js';
import { supabase } from './supabase.js';

export interface BotMetrics {
  totalUsers: number;
  totalWallets: number;
  totalTransactions: number;
  activeUsers24h: number;
  totalVolume24h: number;
  lastUpdated: string;
}

export interface UserActivity {
  userId: string;
  username?: string;
  lastActivity: string;
  totalTransactions: number;
  totalVolume: number;
}

export async function getBotMetrics(): Promise<BotMetrics> {
  try {
    const { data, error } = await supabase.rpc('get_bot_stats');
    
    if (error) {
      logger.error({ error }, 'Failed to get bot stats from database');
      return {
        totalUsers: 0,
        totalWallets: 0,
        totalTransactions: 0,
        activeUsers24h: 0,
        totalVolume24h: 0,
        lastUpdated: new Date().toISOString()
      };
    }

    const stats = data?.[0];
    if (!stats) {
      logger.warn('No bot stats returned from database');
      return {
        totalUsers: 0,
        totalWallets: 0,
        totalTransactions: 0,
        activeUsers24h: 0,
        totalVolume24h: 0,
        lastUpdated: new Date().toISOString()
      };
    }

    return {
      totalUsers: Number(stats.total_users) || 0,
      totalWallets: Number(stats.total_wallets) || 0,
      totalTransactions: Number(stats.total_transactions) || 0,
      activeUsers24h: Number(stats.active_users_24h) || 0,
      totalVolume24h: Number(stats.total_volume_24h) || 0,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    logger.error({ error }, 'Failed to get bot metrics');
    throw error;
  }
}

export async function getTopUsers(limit = 10): Promise<UserActivity[]> {
  try {
    const { data, error } = await supabase.rpc('get_top_users', { limit_count: limit });
    
    if (error) {
      logger.error({ error }, 'Failed to get top users from database');
      return [];
    }

    return (data || []).map((user: any) => ({
      userId: user.user_id,
      username: user.username,
      totalVolume: Number(user.total_volume) || 0,
      totalTransactions: Number(user.total_transactions) || 0,
      lastActivity: user.last_activity
    }));
  } catch (error) {
    logger.error({ error }, 'Failed to get top users');
    throw error;
  }
}

export async function logUserAction(userId: string, action: string, metadata?: any): Promise<void> {
  try {
    logger.info({
      userId,
      action,
      metadata,
      timestamp: new Date().toISOString()
    }, 'User action logged');
  } catch (error) {
    logger.error({ error, userId, action }, 'Failed to log user action');
  }
}

export async function logTradeExecution(
  userId: string,
  tokenAddress: string,
  action: 'buy' | 'sell',
  amount: number,
  priceUsd?: number,
  txHash?: string
): Promise<void> {
  try {
    logger.info({
      userId,
      tokenAddress,
      action,
      amount,
      priceUsd,
      txHash,
      timestamp: new Date().toISOString()
    }, 'Trade execution logged');
  } catch (error) {
    logger.error({ error, userId, action }, 'Failed to log trade execution');
  }
}

export async function logError(error: any, context?: any): Promise<void> {
  try {
    logger.error({
      error: {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
        code: error?.code
      },
      context,
      timestamp: new Date().toISOString()
    }, 'Error logged');
  } catch (logError) {
    console.error('Failed to log error:', logError);
  }
}

export function formatMetrics(metrics: BotMetrics): string {
  let message = `📊 **Bot Statistics**\n\n`;
  message += `👥 **Total Users**: ${metrics.totalUsers.toLocaleString()}\n`;
  message += `💼 **Total Wallets**: ${metrics.totalWallets.toLocaleString()}\n`;
  message += `📈 **Total Transactions**: ${metrics.totalTransactions.toLocaleString()}\n`;
  message += `🔥 **Active Users (24h)**: ${metrics.activeUsers24h.toLocaleString()}\n`;
  message += `💰 **Volume (24h)**: $${metrics.totalVolume24h.toLocaleString()}\n`;
  message += `\n⏰ **Last Updated**: ${new Date(metrics.lastUpdated).toLocaleString()}`;
  
  return message;
}

export function formatTopUsers(users: UserActivity[]): string {
  let message = `🏆 **Top Users by Volume**\n\n`;
  
  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    const rank = i + 1;
    const emoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🏅';
    const username = user.username ? `@${user.username}` : `User ${user.userId.slice(-4)}`;
    
    message += `${emoji} **${rank}.** ${username}\n`;
    message += `   💰 Volume: $${user.totalVolume.toLocaleString()}\n`;
    message += `   📊 Trades: ${user.totalTransactions}\n`;
    message += `   ⏰ Last: ${new Date(user.lastActivity).toLocaleString()}\n\n`;
  }
  
  return message;
}
