import { createClient } from '@supabase/supabase-js';
import { config } from './config.ts';

export const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
	auth: { persistSession: false },
});
