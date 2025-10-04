import 'dotenv/config';
import { Bot, InlineKeyboard, Context } from 'grammy';
import { limit } from '@grammyjs/ratelimiter';
import { logger } from './logger.ts';
import { ensureUserAndWallet, importUserWallet, getUserTransactions, getAllTokenBalances, getHoldingsForUser } from './wallet.ts';
import { scanTokenByAddress } from './tokenScan.ts';
import { buyToken, sellToken } from './trade.ts';
import { createSessionStore } from './sessionStore.ts';
import { createErrorHandler, UserError, NetworkError } from './errorHandler.ts';
import { validateImportCommand, validateScanCommand, validateTradeCommand, validateUserContext } from './validation.ts';
import { checkHealth, formatHealthStatus } from './health.ts';
import { getBotMetrics, getTopUsers, formatMetrics, formatTopUsers, logUserAction, logTradeExecution } from './monitoring.ts';
import { ethers } from 'ethers';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
	throw new Error('TELEGRAM_BOT_TOKEN is required');
}

const bot = new Bot(token);

bot.api.config.use(async (prev, method, payload, signal) => {
	try {
		return await prev(method, payload, signal);
	} catch (err) {
		logger.error({ err }, 'Telegram API error');
		throw err;
	}
});

// Rate limiting
bot.use(limit({
	timeFrame: 1000,
	limit: 5,
	onLimitExceeded: (ctx: any) => ctx.reply('Too many requests. Please slow down.'),
}));

// External session store (Supabase)
bot.use(createSessionStore());

bot.command('start', async (ctx: any) => {
	try {
		const { userId, username } = validateUserContext(ctx);
		await logUserAction(userId, 'start');
		const { address } = await ensureUserAndWallet({ telegramUserId: userId, username: username ?? null });
		await ctx.reply([
			'🚀 **Welcome to DEX Bot!**',
			'Your Base wallet is ready for trading.',
			address ? `\n📍 **Address**: \`${address}\`` : '',
			'\n💰 **To Start Trading:**',
			'**1. Deposit ETH** to your wallet address above',
			'2. Use /scan to find a token',
			'3. Tap Buy/Sell button',
			'4. Reply with: buy <amount> or sell <amount>',
			'\n**Available Commands:**',
			'• /wallet - View your deposit address',
			'• /import <private_key> - Import existing wallet',
			'• /scan <token_address> - View token details',
			'• /balances - View all token balances',
			'• /portfolio - View your holdings',
			'• /transactions - View trade history',
			'• /health - Check system status',
			'• /stats - View bot statistics',
			'• /leaderboard - View top users',
		].filter(Boolean).join('\n'), { parse_mode: 'Markdown' });
	} catch (error) {
		logger.error({ error }, 'Start command failed');
		await ctx.reply('⚠️ Failed to initialize wallet. Please try again.');
	}
});

bot.command('wallet', async (ctx: any) => {
	try {
		const { userId, username } = validateUserContext(ctx);
		await logUserAction(userId, 'wallet');
		const { address } = await ensureUserAndWallet({ telegramUserId: userId, username: username ?? null });
		await ctx.reply(
			address 
				? `💼 **Your Wallet Address (Base)**\n\`${address}\`\n\nSend ETH to this address to start trading!` 
				: '⚠️ Wallet not found. Try /start again.',
			{ parse_mode: 'Markdown' }
		);
	} catch (error) {
		logger.error({ error }, 'Wallet command failed');
		await ctx.reply('⚠️ Failed to retrieve wallet. Please try again.');
	}
});

bot.command('import', async (ctx: any) => {
	try {
		const { userId } = validateUserContext(ctx);
		await logUserAction(userId, 'import');
		const privateKey = validateImportCommand(ctx);
		const { address } = await importUserWallet({ telegramUserId: userId }, privateKey);
		await ctx.reply(
			`✅ **Wallet Imported Successfully!**\n\n**Address**: \`${address}\``,
			{ parse_mode: 'Markdown' }
		);
	} catch (error) {
		if (error instanceof UserError) {
			await ctx.reply(`⚠️ ${error.userMessage}`);
		} else {
			logger.error({ error }, 'Import wallet failed');
			await ctx.reply('⚠️ Failed to import wallet. Please check your private key and try again.');
		}
	}
});

bot.command('balances', async (ctx: any) => {
	try {
		const { userId } = validateUserContext(ctx);
		await logUserAction(userId, 'balances');
		const { address } = await ensureUserAndWallet({ telegramUserId: userId, username: ctx.from?.username ?? null });
		
		// Get ETH balance
		const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
		const wei = await provider.getBalance(address);
		const ethBalance = ethers.formatEther(wei);
		
		// Get all token balances
		const tokenBalances = await getAllTokenBalances(userId);
		
		let message = `💰 **Wallet Balances**\n`;
		message += `Address: \`${address}\`\n\n`;
		
		// Add ETH balance
		message += `**ETH**: ${Number(ethBalance).toFixed(10).replace(/\.?0+$/, '')} ETH\n`;
		
		// Add token balances
		if (tokenBalances.length > 0) {
			message += `\n**Token Holdings:**\n`;
			for (const token of tokenBalances) {
				const formattedBalance = parseFloat(token.balance.toString()).toString();
				message += `• **${token.symbol}**: ${formattedBalance}\n`;
			}
		} else {
			message += `\n**Token Holdings:** None\n`;
		}
		
		await ctx.reply(message, { parse_mode: 'Markdown' });
	} catch (error) {
		logger.error({ error }, 'Failed to fetch balances');
		await ctx.reply('⚠️ Failed to fetch balances. Please try again.');
	}
});

bot.command('portfolio', async (ctx: any) => {
	try {
		const { userId } = validateUserContext(ctx);
		await logUserAction(userId, 'portfolio');
		const holdings = await getHoldingsForUser(userId);
		if (holdings.length === 0) {
			await ctx.reply('📊 **Your Portfolio**\n\nNo holdings yet. Start trading to build your portfolio!', { parse_mode: 'Markdown' });
			return;
		}
		
		let message = `📊 **Your Portfolio Holdings**\n\n`;
		for (const holding of holdings) {
			const netAmount = Number(holding.net_amount);
			const formattedAmount = netAmount.toFixed(10).replace(/\.?0+$/, '');
			
			// P&L indicator based on net amount
			let pnlSymbol = '';
			if (netAmount > 0) {
				pnlSymbol = '+'; // positive net
			} else if (netAmount < 0) {
				pnlSymbol = '-'; // negative net
			}
			
			message += `**${holding.token_address}**: ${pnlSymbol}${formattedAmount}\n`;
		}
		
		await ctx.reply(message, { parse_mode: 'Markdown' });
	} catch (error) {
		logger.error({ error }, 'Failed to fetch portfolio');
		await ctx.reply('⚠️ Failed to fetch portfolio. Please try again.');
	}
});

bot.command('transactions', async (ctx: any) => {
	try {
		const { userId } = validateUserContext(ctx);
		await logUserAction(userId, 'transactions');
		const txs = await getUserTransactions(userId, 20);
		if (txs.length === 0) {
			await ctx.reply('📋 **Transaction History**\n\nNo transactions yet. Start trading to see your history!', { parse_mode: 'Markdown' });
			return;
		}
		
		let message = `📋 **Transaction History**\n\n`;
		const lines = txs.map((t, index) => {
			const amount = Number(t.amount).toFixed(10).replace(/\.?0+$/, '');
			const date = new Date(t.date).toISOString();
			const orderType = t.order_type.toUpperCase();
			const symbol = t.symbol;
			
			return `${index + 1}. **${symbol}** | ${orderType} | ${amount} | ${date}`;
		});
		message += lines.join('\n');
		
		await ctx.reply(message, { parse_mode: 'Markdown' });
	} catch (error) {
		logger.error({ error }, 'Fetch transactions failed');
		await ctx.reply('⚠️ Failed to fetch transactions. Please try again.');
	}
});

bot.command('scan', async (ctx: any) => {
	try {
		const { userId } = validateUserContext(ctx);
		await logUserAction(userId, 'scan');
		const address = validateScanCommand(ctx);
		const res = await scanTokenByAddress(address);
		if (!res) {
			await ctx.reply('⚠️ Token not found. Please check the address and try again.');
			return;
		}
		
		const { token, priceUsd, liquidityUsd, fdvUsd } = res;
		const keyboard = new InlineKeyboard()
			.text('🟢 Buy', `buy:${address}`).text('🔴 Sell', `sell:${address}`);
		
		let message = `🔍 **Token Information**\n\n`;
		message += `**Symbol**: ${token.symbol}\n`;
		message += `**Address**: \`${token.address}\`\n`;
		message += `**Price**: $${priceUsd ? Number(priceUsd).toFixed(10).replace(/\.?0+$/, '').toString().toLocaleString() : 'N/A'}\n`;
		message += `**Liquidity**: $${liquidityUsd?.toLocaleString() || 'N/A'}\n`;
		message += `**FDV**: $${fdvUsd?.toLocaleString() || 'N/A'}\n\n`;
		message += `Choose an action below:`;
		
		await ctx.reply(message, { reply_markup: keyboard, parse_mode: 'Markdown' });
	} catch (error) {
		if (error instanceof UserError) {
			await ctx.reply(`⚠️ ${error.userMessage}`);
		} else {
			logger.error({ error }, 'Scan command failed');
			await ctx.reply('⚠️ Failed to scan token. Please try again.');
		}
	}
});

bot.command('health', async (ctx: any) => {
	try {
		const { userId } = validateUserContext(ctx);
		await logUserAction(userId, 'health_check');
		
		const health = await checkHealth();
		const message = formatHealthStatus(health);
		await ctx.reply(message, { parse_mode: 'Markdown' });
	} catch (error) {
		logger.error({ error }, 'Health check failed');
		await ctx.reply('⚠️ Health check failed. Please try again.');
	}
});

bot.command('stats', async (ctx: any) => {
	try {
		const { userId } = validateUserContext(ctx);
		await logUserAction(userId, 'stats_request');
		
		const metrics = await getBotMetrics();
		const message = formatMetrics(metrics);
		await ctx.reply(message, { parse_mode: 'Markdown' });
	} catch (error) {
		logger.error({ error }, 'Stats request failed');
		await ctx.reply('⚠️ Failed to fetch statistics. Please try again.');
	}
});

bot.command('leaderboard', async (ctx: any) => {
	try {
		const { userId } = validateUserContext(ctx);
		await logUserAction(userId, 'leaderboard_request');
		
		const topUsers = await getTopUsers(10);
		const message = formatTopUsers(topUsers);
		await ctx.reply(message, { parse_mode: 'Markdown' });
	} catch (error) {
		logger.error({ error }, 'Leaderboard request failed');
		await ctx.reply('⚠️ Failed to fetch leaderboard. Please try again.');
	}
});

bot.on('callback_query:data', async (ctx: any) => {
	try {
		const data = ctx.callbackQuery.data as string;
		const m = data.match(/^(buy|sell):(0x[a-fA-F0-9]{40})$/);
		if (!m) {
			await ctx.answerCallbackQuery('Invalid action');
			return;
		}
		
		const [, action, address] = m as any;
		await ctx.answerCallbackQuery();
		
		// Log user action for buy/sell button clicks
		if (ctx.from?.id) {
			await logUserAction(String(ctx.from.id), `${action}_button_click`);
		}
		
		if (action === 'buy') {
			await ctx.reply('💰 Buy Token: How much ETH to spend?\nSend: `buy <amount in ETH>`', { parse_mode: 'Markdown' });
		} else {
			await ctx.reply('💸 Sell Token: How much to sell?\nSend: `sell <amount in token units>`', { parse_mode: 'Markdown' });
		}
		
		(ctx as any).session = { ...((ctx as any).session ?? {}), pendingAction: { action, address } };
	} catch (error) {
		logger.error({ error }, 'Callback query failed');
		await ctx.answerCallbackQuery('An error occurred');
	}
});

bot.on('message:text', async (ctx: any) => {
	try {
		const text = ctx.message.text.trim();
		const pending = (ctx.session as any)?.pendingAction as { action: 'buy'|'sell'; address: string } | undefined;
		
		// Check if this looks like a trade command
		const tradeMatch = text.match(/^(buy|sell)\s+([0-9]*\.?[0-9]+)$/i);
		
		if (!pending && tradeMatch) {
			await ctx.reply('⚠️ Please /scan a token and tap Buy/Sell first.');
			return;
		}
		
		if (pending && tradeMatch) {
			const { action, amount } = validateTradeCommand(text);
			
			if (action !== pending.action) {
				await ctx.reply(`⚠️ Action mismatch. Send like: \`${pending.action} <amount>\``, { parse_mode: 'Markdown' });
				return;
			}
			
			logger.debug({ pending, amount }, 'Executing trade');
			
			let tradeResult;
			if (pending.action === 'buy') {
				tradeResult = await buyToken(String(ctx.from?.id), pending.address, amount);
				await logTradeExecution(String(ctx.from?.id), pending.address, 'buy', amount, tradeResult.priceUsd || undefined, tradeResult.hash);
				
				// Send detailed buy confirmation
				let buyMessage = `✅ **Buy Successful!**\n\n`;
				buyMessage += `**Token**: ${tradeResult.symbol}\n`;
				buyMessage += `**Amount**: ${Number(tradeResult.tokensReceived).toFixed(10).replace(/\.?0+$/, '')} ${tradeResult.symbol}\n`;
				buyMessage += `**ETH Spent**: ${Number(tradeResult.ethSpent).toFixed(10).replace(/\.?0+$/, '')} ETH\n`;
				if (tradeResult.priceUsd) {
					buyMessage += `**Price**: $${Number(tradeResult.priceUsd).toFixed(10).replace(/\.?0+$/, '').toString().toLocaleString()}\n`;
				}
				buyMessage += `**TX Hash**: \`${tradeResult.hash}\`\n\n`;
				
				// Get updated portfolio
				const holdings = await getHoldingsForUser(String(ctx.from?.id));
				if (holdings.length > 0) {
					buyMessage += `**Updated Portfolio:**\n`;
					for (const holding of holdings.slice(0, 5)) { // Show top 5 holdings
						const netAmount = Number(holding.net_amount);
						const formattedAmount = netAmount.toFixed(10).replace(/\.?0+$/, '');
						
						// P&L indicator based on net amount
						let pnlSymbol = '';
						if (netAmount > 0) {
							pnlSymbol = '+'; // positive net
						} else if (netAmount < 0) {
							pnlSymbol = '-'; // negative net
						}
						
						buyMessage += `• **${holding.token_address}**: ${pnlSymbol}${formattedAmount}\n`;
					}
					if (holdings.length > 5) {
						buyMessage += `• ... and ${holdings.length - 5} more\n`;
					}
				}
				
				await ctx.reply(buyMessage, { parse_mode: 'Markdown' });
			} else {
				tradeResult = await sellToken(String(ctx.from?.id), pending.address, amount);
				await logTradeExecution(String(ctx.from?.id), pending.address, 'sell', amount, tradeResult.priceUsd || undefined, tradeResult.hash);
				
				// Send detailed sell confirmation
				let sellMessage = `✅ **Sell Successful!**\n\n`;
				sellMessage += `**Token**: ${tradeResult.symbol}\n`;
				sellMessage += `**Amount Sold**: ${Number(tradeResult.tokensSold).toFixed(10).replace(/\.?0+$/, '')} ${tradeResult.symbol}\n`;
				sellMessage += `**ETH Received**: ${Number(tradeResult.ethReceived).toFixed(10).replace(/\.?0+$/, '')} ETH\n`;
				if (tradeResult.priceUsd) {
					sellMessage += `**Price**: $${Number(tradeResult.priceUsd).toFixed(10).replace(/\.?0+$/, '').toString().toLocaleString()}\n`;
				}
				sellMessage += `**TX Hash**: \`${tradeResult.hash}\`\n\n`;
				
				// Get updated portfolio
				const holdings = await getHoldingsForUser(String(ctx.from?.id));
				if (holdings.length > 0) {
					sellMessage += `**Updated Portfolio:**\n`;
					for (const holding of holdings.slice(0, 5)) { // Show top 5 holdings
						const netAmount = Number(holding.net_amount);
						const formattedAmount = netAmount.toFixed(10).replace(/\.?0+$/, '');
						
						// P&L indicator based on net amount
						let pnlSymbol = '';
						if (netAmount > 0) {
							pnlSymbol = '+'; // positive net
						} else if (netAmount < 0) {
							pnlSymbol = '-'; // negative net
						}
						
						sellMessage += `• **${holding.token_address}**: ${pnlSymbol}${formattedAmount}\n`;
					}
					if (holdings.length > 5) {
						sellMessage += `• ... and ${holdings.length - 5} more\n`;
					}
				} else {
					sellMessage += `**Portfolio**: No holdings remaining\n`;
				}
				
				await ctx.reply(sellMessage, { parse_mode: 'Markdown' });
			}
			
			(ctx as any).session = { ...((ctx as any).session ?? {}), pendingAction: undefined };
		}
	} catch (error) {
		if (error instanceof UserError) {
			await ctx.reply(`⚠️ ${error.userMessage}`);
		} else {
			logger.error({ error }, 'Message handler failed');
			await ctx.reply('⚠️ An error occurred. Please try again.');
		}
	}
});

// Error handling
bot.catch((err) => {
  logger.error({ err }, 'Bot error');
});

bot.start();
logger.info('Bot started');
