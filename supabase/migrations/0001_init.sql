create table if not exists public.users (
	id bigserial primary key,
	telegram_user_id text unique,
	username text,
	created_at timestamptz default now()
);

create table if not exists public.wallets (
	telegram_user_id text primary key references public.users(telegram_user_id) on delete cascade,
	address text not null,
	encrypted_private_key jsonb not null,
	created_at timestamptz default now()
);

-- Single transactions table aligned with Excel columns, per-user
create table if not exists public.transactions (
	id bigserial primary key,
	telegram_user_id text,
	symbol text not null,
	amount numeric not null,
	price_usd numeric,
	order_type text not null check (order_type in ('buy','sell')),
	date timestamptz not null default now()
);

create index if not exists idx_transactions_user on public.transactions(telegram_user_id);


create table if not exists public.bot_sessions (
	chat_id text primary key,
	data jsonb not null default '{}'::jsonb,
	updated_at timestamptz default now()
);

-- Function to get user holdings (net amounts per token)
create or replace function get_holdings_for_user(p_telegram_user_id text)
returns table(token_address text, net_amount numeric)
language sql
as $$
	select 
		symbol as token_address,
		sum(case when order_type = 'buy' then amount else -amount end) as net_amount
	from transactions 
	where telegram_user_id = p_telegram_user_id
	group by symbol
	having sum(case when order_type = 'buy' then amount else -amount end) > 0;
$$;

-- Function to get bot statistics
create or replace function get_bot_stats()
returns table(
	total_users bigint,
	total_wallets bigint,
	total_transactions bigint,
	active_users_24h bigint,
	total_volume_24h numeric
)
language sql
as $$
	select 
		(select count(*) from users) as total_users,
		(select count(*) from wallets) as total_wallets,
		(select count(*) from transactions) as total_transactions,
		(select count(distinct telegram_user_id) from transactions 
		 where date >= now() - interval '24 hours') as active_users_24h,
		(select coalesce(sum(amount * price_usd), 0) from transactions 
		 where date >= now() - interval '24 hours' and price_usd is not null) as total_volume_24h;
$$;

-- Function to get top users by volume
create or replace function get_top_users(limit_count integer default 10)
returns table(
	user_id text,
	username text,
	total_volume numeric,
	total_transactions bigint,
	last_activity timestamptz
)
language sql
as $$
	select 
		u.telegram_user_id as user_id,
		u.username,
		coalesce(sum(t.amount * t.price_usd), 0) as total_volume,
		count(t.id) as total_transactions,
		max(t.date) as last_activity
	from users u
	left join transactions t on u.telegram_user_id = t.telegram_user_id
	group by u.telegram_user_id, u.username
	having count(t.id) > 0
	order by total_volume desc
	limit limit_count;
$$;
