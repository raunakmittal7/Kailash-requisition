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

## Reading slips, quotations and price lists

Photos of handwritten slips, vendor quotations and price lists are read by Claude through the server function `api/read.js`.
It only works for signed-in people, and the Anthropic API key stays on the server.

To switch it on: in Vercel, open the project, go to Settings, then Environment Variables, and add `ANTHROPIC_API_KEY`
with a key from console.anthropic.com. Then redeploy. Until the key is added, the website says the reading is coming soon
and everything can still be typed in by hand.

## Not live yet

- WhatsApp sending through AiSensy. Messages queue in the `outbox` table and show on the WhatsApp outbox page.
- PDF download of purchase orders, and the Tally sync.
