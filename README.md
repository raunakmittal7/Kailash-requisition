# Kailasha Group material requisition website

The live website is the set of files at the top of this repository. Vercel serves them as they are, with no build step.

- `index.html`: all the screens (made from the beta, v8).
- `live.js`: loads data from Supabase and saves every change, so that each person's database rules apply.
- `config.js`: the Supabase address and the **publishable** key. This key is meant to be public. Never put the secret key here.
- `vendor/`: a fixed copy of the Supabase browser library.
- `supabase/setup.sql`: the one-time database setup (already run).
- `supabase/migrations/001_live_website.sql`: logins, the extra tables and rule fixes for the live website. Run it once, after setup.sql.
- `beta/index.html`: the old clickable beta with sample data.
- `tests/live/`: an end-to-end test that runs the website against a local Postgres with a small stand-in for Supabase.

## Logins

People log in with their mobile number and a password. Inside Supabase the login name is `<mobile>@phone.kailasha.local`, and nothing is ever sent to that address. Raunak's account is created once in the SQL Editor with `add_person(...)`. After that, people are added from the website under Settings → People, which Raunak can do. Logging in with a WhatsApp code comes once AiSensy is connected.

## Not live yet

- WhatsApp sending through AiSensy. Messages queue in the `outbox` table and show on the WhatsApp outbox page.
- Reading quotations, slips and price lists with Claude. This needs a server function and an Anthropic API key. Until then, rates are typed in by hand.
- PDF download of purchase orders, and the Tally sync.
