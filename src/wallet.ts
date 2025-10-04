import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { ethers } from 'ethers';
import { config } from './config.js';
import { supabase } from './supabase.js';
import { logger } from './logger.js';
import { WalletError } from './errorHandler.js';

function getKey(): Buffer {
	return Buffer.from(config.ENCRYPTION_KEY_BASE64, 'base64');
}

function encryptPrivateKey(pkHex: string): { iv: string; ciphertext: string; tag: string } {
	const key = getKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(Buffer.from(pkHex.replace(/^0x/, ''), 'hex')), cipher.final()]);
	const tag = cipher.getAuthTag();
	return { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: tag.toString('base64') };
}

function decryptPrivateKey(enc: { iv: string; ciphertext: string; tag: string }): string {
	const key = getKey();
	const iv = Buffer.from(enc.iv, 'base64');
	const tag = Buffer.from(enc.tag, 'base64');
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAuthTag(tag);
	const plaintext = Buffer.concat([
		decipher.update(Buffer.from(enc.ciphertext, 'base64')),
		decipher.final(),
	]);
	return '0x' + plaintext.toString('hex');
}

export async function ensureUserAndWallet(input: { telegramUserId: string; username: string | null }): Promise<{ address: string }> {
	const { data: user } = await supabase.from('users').select('*').eq('telegram_user_id', input.telegramUserId).maybeSingle();
	if (!user) {
		const wallet = ethers.Wallet.createRandom();
		const enc = encryptPrivateKey(wallet.privateKey);
		await supabase.from('users').insert({ telegram_user_id: input.telegramUserId, username: input.username });
		await supabase.from('wallets').insert({ telegram_user_id: input.telegramUserId, address: wallet.address, encrypted_private_key: enc });
		return { address: wallet.address };
	}
	const { data: w } = await supabase.from('wallets').select('*').eq('telegram_user_id', input.telegramUserId).maybeSingle();
	if (!w) {
		const wallet = ethers.Wallet.createRandom();
		const enc = encryptPrivateKey(wallet.privateKey);
		await supabase.from('wallets').insert({ telegram_user_id: input.telegramUserId, address: wallet.address, encrypted_private_key: enc });
		return { address: wallet.address };
	}
	return { address: w.address as string };
}

export async function importUserWallet(input: { telegramUserId: string }, pkHex: string): Promise<{ address: string }> {
	const wallet = new ethers.Wallet(pkHex);
	const enc = encryptPrivateKey(wallet.privateKey);
	await supabase.from('wallets').upsert({ telegram_user_id: input.telegramUserId, address: wallet.address, encrypted_private_key: enc });
	return { address: wallet.address };
}

export async function getSignerForUser(telegramUserId: string): Promise<ethers.Wallet> {
	const { data: w, error } = await supabase.from('wallets').select('*').eq('telegram_user_id', telegramUserId).maybeSingle();
	if (!w) throw new WalletError('Wallet not found. Please use /start to create a wallet.');
	const pk = decryptPrivateKey(w.encrypted_private_key);
	const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
	return new ethers.Wallet(pk, provider);
}

export async function getHoldingsForUser(telegramUserId: string): Promise<Array<{ token_address: string; net_amount: string }>> {
	const { data, error } = await supabase.rpc('get_holdings_for_user', { p_telegram_user_id: telegramUserId });
	if (error) throw error;
	return data ?? [];
}

export async function getWalletAddressForUser(telegramUserId: string): Promise<string | null> {
	const { data, error } = await supabase.from('wallets').select('address').eq('telegram_user_id', telegramUserId).maybeSingle();
	if (error) return null;
	return data?.address ?? null;
}

export async function getUserTransactions(telegramUserId: string, limit = 20): Promise<Array<{ symbol: string; amount: number; order_type: string; date: string }>> {
	const { data, error } = await supabase
		.from('transactions')
		.select('symbol, amount, order_type, date')
		.eq('telegram_user_id', telegramUserId)
		.order('date', { ascending: false })
		.limit(limit);
	if (error) throw error;
	return (data ?? []) as any;
}

export async function recordTransaction(input: {
	telegramUserId: string;
	symbol: string;
	amount: number;
	priceUsd: number | null;
	orderType: 'buy' | 'sell';
}): Promise<void> {
	const { data, error } = await supabase.from('transactions').insert({
		telegram_user_id: input.telegramUserId,
		symbol: input.symbol,
		amount: input.amount,
		price_usd: input.priceUsd,
		order_type: input.orderType,
		date: new Date().toISOString(),
	});
	if (error) throw error;
}

export async function getAllTokenBalances(telegramUserId: string): Promise<Array<{
	symbol: string;
	address: string;
	balance: string;
	decimals: number;
	priceUsd?: number;
}>> {
	const { data: wallet } = await supabase.from('wallets').select('address').eq('telegram_user_id', telegramUserId).single();
	if (!wallet) return [];
	
	const address = wallet.address;
	
	return await getTokenBalancesFromAlchemy(address);
}

async function getTokenBalancesFromAlchemy(address: string): Promise<Array<{
	symbol: string;
	address: string;
	balance: string;
	decimals: number;
	priceUsd?: number;
}>> {
	const alchemyUrl = config.ALCHEMY_URL;
	
	// Get token balances
	const balanceResponse = await fetch(alchemyUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'alchemy_getTokenBalances',
			params: [address],
			id: 1,
		}),
	});
	
	if (!balanceResponse.ok) {
		throw new Error(`Alchemy API error: ${balanceResponse.status}`);
	}
	
	const balanceData = await balanceResponse.json();
	if (balanceData.error) {
		throw new Error(`Alchemy API error: ${balanceData.error.message}`);
	}
	
		logger.debug({ tokenCount: balanceData.length }, 'getTokenBalancesFromAlchemy balance data');
	
	const balances = [];
	const nonZeroBalances = balanceData.result.tokenBalances.filter(
		(token: any) => token.tokenBalance !== '0x0'
	);
	
	// Get metadata for all tokens in parallel
	const metadataPromises = nonZeroBalances.map(async (tokenBalance: any) => {
		try {
			const metadataResponse = await fetch(alchemyUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					method: 'alchemy_getTokenMetadata',
					params: [tokenBalance.contractAddress],
					id: 1,
				}),
			});
			
			if (!metadataResponse.ok) {
				return null;
			}
			
			const metadataData = await metadataResponse.json();
			if (metadataData.error) {
				return null;
			}
			
			const metadata = metadataData.result;
			
			// Skip tokens with UNKNOWN symbol
			if (!metadata.symbol || metadata.symbol === 'UNKNOWN') {
				return null;
			}
			
			const balance = ethers.formatUnits(tokenBalance.tokenBalance, metadata.decimals || 18);
			

			if (
				// 🚩 1. Suspicious keywords in name or symbol
				/(t\.me|claim|redeem|airdrop|bonus|reward|free|cpool|launch|drop|click|invite)/i.test(metadata.name + metadata.symbol) ||
			  
				// 🚩 2. Any URL, domain, or short link present
				/(https?:\/\/|http:\/\/|t\.ly|bit\.ly|tinyurl|discord\.gg|\.com|\.xyz|\.io|\.org)/i.test(metadata.name + metadata.symbol) ||
			  
				// 🚩 3. Symbol too short or too long (most are 2–10 chars)
				metadata.symbol.length < 2 || metadata.symbol.length > 12 ||
			  
				// 🚩 4. Name too long (spammy tokens often have long names)
				metadata.name.length > 50 ||
			  
				// 🚩 5. Zero balance (dust / airdrop spam)
				parseFloat(balance) === 0 ||
			  
				// 🚩 6. Contains invisible characters (like zero-width space or Cyrillic)
				/[\u200B-\u200D\uFEFF]/.test(metadata.symbol + metadata.name) ||
			  
				// 🚩 7. Non-ASCII characters (Cyrillic, emojis, etc.)
				!/^[\x00-\x7F]*$/.test(metadata.symbol + metadata.name)
			  ) {
				return null;
			  }
			  

			return {
				symbol: metadata.symbol,
				address: tokenBalance.contractAddress,
				balance,
				decimals: metadata.decimals || 18,
				priceUsd: undefined,
			};
		} catch (error) {
			// Skip invalid tokens
			return null;
		}
	});
	
	const results = await Promise.all(metadataPromises);
	
	// Filter out null results (failed metadata fetches)
	return results.filter((result): result is NonNullable<typeof result> => result !== null);
}
