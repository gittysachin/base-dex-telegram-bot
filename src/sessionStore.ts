import type { MiddlewareFn } from 'grammy';
import { supabase } from './supabase.ts';
import { logger } from './logger.ts';

export function createSessionStore(): MiddlewareFn {
	return async (ctx, next) => {
		const sessionId = String(ctx.from?.id ?? ctx.chat?.id ?? '');
		if (!sessionId) return next();

		let loaded: any = {};
		try {
			const { data, error } = await supabase
				.from('bot_sessions')
				.select('data')
				.eq('chat_id', sessionId)
				.maybeSingle();
			if (error) {
				logger.error({ error, sessionId, code: (error as any).code }, 'Session load error');
			} else if (data?.data) {
				loaded = data.data;
			}
		} catch (e) {
			logger.error({ e, sessionId }, 'Session load exception');
		}

		(ctx as any).session = loaded ?? {};
		await next();

		try {
			const payload = (ctx as any).session ?? {};
			const { error } = await supabase
				.from('bot_sessions')
				.upsert({ chat_id: sessionId, data: payload });
			if (error) {
				logger.error({ error, sessionId, code: (error as any).code }, 'Session save error');
			}
		} catch (e) {
			logger.error({ e, sessionId }, 'Session save exception');
		}
	};
}
