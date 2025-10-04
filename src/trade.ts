import { config } from './config.js';
import { getSignerForUser, recordTransaction } from './wallet.js';
import { ethers } from 'ethers';
import { getUsdPrice } from './tokenScan.js';
import { logger } from './logger.js';
import { TradeError, NetworkError } from './errorHandler.js';

const ERC20_ABI = [
	"function symbol() view returns (string)",
	"function decimals() view returns (uint8)",
	"function allowance(address owner, address spender) view returns (uint256)",
	"function approve(address spender, uint256 value) returns (bool)"
];

function ethNative(): string { return '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; }

async function fetchQuote(params: Record<string, string>): Promise<any> {
	const url = new URL(config.ZEROX_SWAP_BASE_URL);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	if (!url.searchParams.has('chainId')) url.searchParams.set('chainId', String(config.BASE_CHAIN_ID));
	logger.debug({ url: url.toString() }, '0x fetchQuote request');
	const res = await fetch(url.toString(), {
		headers: {
			...(config.ZEROX_API_KEY ? { '0x-api-key': config.ZEROX_API_KEY } : {}),
			'0x-version': 'v2',
		},
	});
	logger.debug({ status: res.status }, '0x fetchQuote response');
	if (!res.ok) {
		logger.error({ status: res.status }, '0x fetchQuote failed');
		throw new Error(`0x quote error ${res.status}`);
	}
	const json = await res.json();
	
	// Check if liquidity is available
	if (!json.liquidityAvailable) {
		logger.warn('No liquidity available for this trade');
		throw new TradeError('No liquidity available for this trade. Try a different amount or token.');
	}
	
	logger.debug({ hasTransaction: Boolean(json?.transaction) }, '0x fetchQuote parsed');
	return json;
}

async function ensureAllowanceIfNeeded(signer: ethers.Wallet, token: string, spender: string, amount: bigint) {
	const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
	const owner = await signer.getAddress();
	const current: bigint = await erc20.allowance(owner, spender);
	if (current >= amount) return;
	const tx = await erc20.approve(spender, amount);
	await tx.wait();
}

export async function buyToken(telegramUserId: string, tokenAddress: string, amountEthUnits: number): Promise<{
	hash: string;
	symbol: string;
	tokensReceived: number;
	ethSpent: number;
	priceUsd: number | null;
}> {
	logger.debug({ telegramUserId, tokenAddress, amountEthUnits }, 'buyToken start');
	const signer = await getSignerForUser(telegramUserId);
	const taker = await signer.getAddress();
	const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
	const [decimals, symbol, priceUsd] = await Promise.all([
		erc20.decimals(),
		erc20.symbol().catch(() => 'TOKEN'),
		getUsdPrice(tokenAddress),
	]);
	logger.debug({ decimals, symbol, priceUsd }, 'buyToken token meta');
	
	// Convert ETH amount to wei (18 decimals)
	const sellAmountRaw = ethers.parseEther(amountEthUnits.toString());
	if (sellAmountRaw <= 0n) {
		throw new Error('Amount too small. Increase amount.');
	}
	logger.debug({ sellAmountRaw: sellAmountRaw.toString() }, 'buyToken computed sellAmountRaw (ETH in wei)');
	
	const quoteParams = {
		buyToken: tokenAddress,    // We want to BUY this token
		sellToken: ethNative(),    // We want to SELL ETH for it
		sellAmount: sellAmountRaw.toString(), // Amount of ETH to sell
		taker,
	};
	logger.debug('buyToken fetching quote');
	const quote = await fetchQuote(quoteParams);
	logger.debug({ 
		liquidityAvailable: quote.liquidityAvailable,
		hasTransaction: Boolean(quote.transaction)
	}, 'buyToken got quote');
	
	if (!quote.transaction && !quote.to) {
		throw new TradeError('Invalid quote response: missing transaction data');
	}

	const to = quote.transaction?.to ?? quote.to;
	const data = quote.transaction?.data ?? quote.data;
	const value = quote.transaction?.value ?? quote.value ?? '0';
	logger.debug({ to }, 'buyToken sending transaction');
	const tx = await signer.sendTransaction({ to, data, value: BigInt(value) });
	logger.info({ hash: tx.hash }, 'buyToken tx submitted');
	const receipt = await tx.wait();
	logger.info({ hash: tx.hash, status: receipt?.status }, 'buyToken tx confirmed');
	
	// Only record transaction if it was successful (status = 1)
	if (receipt?.status !== 1) {
		throw new TradeError(`Transaction failed with status: ${receipt?.status}`);
	}
	
	// Calculate how many tokens were actually received
	const tokensReceived = quote.buyAmount ? ethers.formatUnits(quote.buyAmount, decimals) : '0';
	logger.debug({ tokensReceived, ethSpent: amountEthUnits }, 'buyToken calculated amounts');
	
	await recordTransaction({
		telegramUserId,
		symbol,
		amount: parseFloat(tokensReceived), // Amount of tokens actually received
		priceUsd: priceUsd ?? null,
		orderType: 'buy',
	});
	logger.debug({ telegramUserId, symbol, tokensReceived, ethSpent: amountEthUnits }, 'buyToken db insert complete');
	return {
		hash: tx.hash,
		symbol,
		tokensReceived: parseFloat(tokensReceived),
		ethSpent: amountEthUnits,
		priceUsd: priceUsd ?? null
	};
}

export async function sellToken(telegramUserId: string, tokenAddress: string, amountTokenUnits: number): Promise<{
	hash: string;
	symbol: string;
	tokensSold: number;
	ethReceived: number;
	priceUsd: number | null;
}> {
	const signer = await getSignerForUser(telegramUserId);
	const taker = await signer.getAddress();
	const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
	const [decimals, symbol, priceUsd] = await Promise.all([
		erc20.decimals(),
		erc20.symbol().catch(() => 'TOKEN'),
		getUsdPrice(tokenAddress),
	]);
	const amountRaw = ethers.parseUnits(amountTokenUnits.toString(), decimals);
	if (amountRaw <= 0n) {
		throw new TradeError('Amount too small. Increase amount.');
	}
	logger.debug({ sellAmount: amountRaw.toString(), taker }, 'sellToken fetching quote');
	const quote = await fetchQuote({
		buyToken: ethNative(),
		sellToken: tokenAddress,
		sellAmount: amountRaw.toString(),
		taker,
	});
	logger.info({ 
		liquidityAvailable: quote.liquidityAvailable,
		hasTransaction: Boolean(quote.transaction), 
		to: quote.transaction?.to ?? quote.to, 
		value: quote.transaction?.value ?? quote.value,
		buyAmount: quote.buyAmount,
		sellAmount: quote.sellAmount
	}, 'sellToken got quote');
	
	if (!quote.transaction && !quote.to) {
		throw new TradeError('Invalid quote response: missing transaction data');
	}
	
	// Handle allowance for selling tokens
	const allowanceSpender: string | undefined = quote.allowanceTarget;
	if (allowanceSpender) {
		logger.debug({ allowanceSpender, sellAmount: quote.sellAmount ?? amountRaw.toString() }, 'sellToken ensuring allowance');
		await ensureAllowanceIfNeeded(signer, tokenAddress, allowanceSpender, BigInt(quote.sellAmount ?? amountRaw.toString()));
	}
	const to = quote.transaction?.to ?? quote.to;
	const data = quote.transaction?.data ?? quote.data;
	const value = quote.transaction?.value ?? quote.value ?? '0';
	logger.debug({ to }, 'sellToken sending transaction');
	const tx = await signer.sendTransaction({ to, data, value: BigInt(value) });
	logger.info({ hash: tx.hash }, 'sellToken tx submitted');
	const receipt = await tx.wait();
	logger.info({ hash: tx.hash, status: receipt?.status }, 'sellToken tx confirmed');
	
	// Only record transaction if it was successful (status = 1)
	if (receipt?.status !== 1) {
		throw new TradeError(`Transaction failed with status: ${receipt?.status}`);
	}
	
	await recordTransaction({
		telegramUserId,
		symbol,
		amount: amountTokenUnits,
		priceUsd: priceUsd ?? null,
		orderType: 'sell',
	});
	
	// Calculate ETH received from the quote
	const ethReceived = quote.buyAmount ? parseFloat(ethers.formatEther(quote.buyAmount)) : 0;
	
	logger.debug({ telegramUserId, symbol, amountTokenUnits, ethReceived }, 'sellToken db insert complete');
	return {
		hash: tx.hash,
		symbol,
		tokensSold: amountTokenUnits,
		ethReceived,
		priceUsd: priceUsd ?? null
	};
}

