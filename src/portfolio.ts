import { supabase } from './supabase.ts';

export async function getHoldings(telegramUserId: string) {
	const { data, error } = await supabase
		.from('transactions')
		.select('symbol, amount, order_type, telegram_user_id')
		.eq('telegram_user_id', telegramUserId);
	if (error) throw error;
	const map = new Map<string, number>();
	for (const row of data ?? []) {
		const delta = row.order_type === 'buy' ? Number(row.amount) : -Number(row.amount);
		map.set(row.symbol, (map.get(row.symbol) ?? 0) + delta);
	}
	return Array.from(map.entries()).map(([symbol, net_amount]) => ({ symbol, net_amount }));
}

