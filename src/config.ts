import { z } from 'zod';

const schema = z.object({
	SUPABASE_URL: z.string().url(),
	SUPABASE_ANON_KEY: z.string(),
	BASE_RPC_URL: z.string().url(),
	BASE_CHAIN_ID: z.coerce.number().default(8453),
	ZEROX_API_KEY: z.string().optional(),
	ZEROX_SWAP_BASE_URL: z.string().url().default('https://api.0x.org/swap/allowance-holder/quote'),
	ENCRYPTION_KEY_BASE64: z.string(),
	DEXSCREENER_API_BASE: z.string().url().default('https://api.dexscreener.com/latest/dex'),
	ALCHEMY_URL: z.string().url(),
});

export const config = schema.parse(process.env);
