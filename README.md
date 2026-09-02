# Aqra Ace Live

This is a real multi-user web app starter, not a localStorage-only mockup.

## What works
- Real account registration/login
- PostgreSQL persistence
- Codename profiles
- Age-compatible discovery (broad ±2 years)
- Friend requests + acceptance
- Mutual-friend-only messaging
- Real-time WebSocket chat
- Report and block endpoints
- Responsive mobile UI

## Run locally
1. Install Node.js 20+.
2. Create a PostgreSQL database.
3. Set environment variables:
   - `DATABASE_URL=...`
   - `JWT_SECRET=...`
4. Run `npm install`
5. Run `npm start`
6. Open `http://localhost:3000`

## Deploy
Deploy the project to a Node-compatible host and attach PostgreSQL. Set `DATABASE_URL` and a strong random `JWT_SECRET`.

## Important production work
This is a functional foundation, not a finished safeguarding system. Before opening it to real teenagers, add verified age/eligibility enforcement, adult/safety moderation workflows, secure report storage, rate limiting, abuse detection, account recovery, privacy/consent procedures appropriate to each jurisdiction, data retention/deletion controls, HTTPS, secure cookies or another hardened session strategy, and a real moderation/admin dashboard.

Do not use exact location matching or expose personal contact details.


## Age range
Aqra Ace registration accepts ages 13 through 20 inclusive. Because this includes minors and adults, production deployment should enforce appropriate age-separation, safeguarding, moderation, and consent rules rather than treating all users as one unrestricted social group.
