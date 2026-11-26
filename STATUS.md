# Website status

## v1.0-live, 26 Nov 2026 (restore point: commit 4d01f17)

What works on the live website (kailashrequisition.vercel.app, Supabase Mumbai):
- Logins with mobile number and password; Raunak adds people and resets passwords in Settings.
- Requisitions for Jaigaon, Matigara, Talma and Kaveri Agro, with deadlines and urgent nudges.
- Approval flows: real estate Ajay -> quotes -> Raunak -> PO; Kaveri Agro Ravi -> Ajay -> quotes -> Raunak -> PO.
  Send back for clarification, reject with a 4-digit PIN, delegation while travelling.
- Ravi sees only Kaveri Agro (unless approvals are handed to him). Storekeepers see only their site, no rates.
- Vendor quotes and comparison; PO numbers like KG/KAL/PO/...; billing company per site, chosen per PO.
- Receipts, partial delivery, PO close requests, quantity changes (<=10% PM, >10% trio), stock for Kaveri Agro.
- AI (Claude Haiku, Sonnet for unclear files): reading slip photos, vendor quotes and price lists;
  proper market names for new items before sending.
- One-screen dashboard for Raunak, Ajay and Ravi: overdue, urgent, waiting, waiting on others.
- Billing companies set for MAT (AKA Ventures), JAI (Ajay Agarwal, Saroj Devi Mittal), KAL (Kaveri Agro LLP).

Not on yet: WhatsApp messages (AiSensy) and WhatsApp OTP login, PO PDF download, Tally sync,
Talma billing company, storekeeper logins for Jaigaon and Talma.

To roll back: in Vercel, Deployments, find the deployment of commit 4d01f17 and choose "Promote to Production",
or ask Claude to restore v1.0-live.

