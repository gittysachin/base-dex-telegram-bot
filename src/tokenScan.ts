import { config } from './config.ts';
import { logger } from './logger.ts';

export type TokenScan = {
	token: { address: string; symbol: string; decimals?: number };
	priceUsd?: number;
	liquidityUsd?: number;
	fdvUsd?: number;
};

export async function scanTokenByAddress(address: string): Promise<TokenScan | null> {
	const url = `${config.DEXSCREENER_API_BASE}/tokens/${address}`;
	const res = await fetch(url);
	if (!res.ok) {
		logger.warn({ status: res.status }, 'DexScreener error');
		return null;
	}
	const json = await res.json();
	const pair = json.pairs?.[0];
	if (!pair) return null;
	const data: TokenScan = {
		token: { address: pair.baseToken.address, symbol: pair.baseToken.symbol, decimals: pair.baseToken.decimals },
		priceUsd: pair.priceUsd ? Number(pair.priceUsd) : undefined,
		liquidityUsd: pair.liquidity?.usd ? Number(pair.liquidity.usd) : undefined,
		fdvUsd: pair.fdv ? Number(pair.fdv) : undefined,
	};
	return data;
}

export async function getUsdPrice(address: string): Promise<number | null> {
	const scan = await scanTokenByAddress(address);
	return scan?.priceUsd ?? null;
}
