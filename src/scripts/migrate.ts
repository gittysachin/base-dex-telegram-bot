import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

async function run() {
	const dbUrl = process.env.SUPABASE_CONNECTION_STRING;
	if (!dbUrl) {
		throw new Error('SUPABASE_DB_URL is required (postgres connection string)');
	}
	const client = new Client({ connectionString: dbUrl });
	await client.connect();
	try {
		const dir = join(process.cwd(), 'supabase', 'migrations');
		const files = readdirSync(dir)
			.filter((f) => f.endsWith('.sql'))
			.sort();
		for (const f of files) {
			const sql = readFileSync(join(dir, f), 'utf8');
			process.stdout.write(`Applying ${f}... `);
			await client.query(sql);
			process.stdout.write('done\n');
		}
	} finally {
		await client.end();
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
