# Booking

Online appointments for a small business with one person or one chair (a salon, a consultant, a clinic, a tutor):
customers choose a service, a day and a free time, leave their name and email and get a booking code, with an
"add to calendar" file. Bookings never overlap, whatever the service, and two people can't take the same time.
The admin shows the agenda by day (confirm, cancel, contact the customer, CSV export) and edits the services,
the weekly opening hours, days off and the booking rules.

Runs as one Cloudflare Worker (Hono API + static files in `public/`) with a D1 database. The page speaks
Brazilian Portuguese, English and Spanish, following the visitor's browser.

Times are kept as wall-clock text in the business time zone (Settings, default `America/Sao_Paulo`): the slots,
"now", the minimum notice and the booking window are all computed in that time zone by the Worker.

## Admin password

The admin (`/admin`) uses the `ADMIN_PASSWORD` variable. bohr sets it when it creates the project; to change it,
edit the site variable in bohr or run `npx wrangler secret put ADMIN_PASSWORD`. Without it the admin stays
closed and explains how to set it.

## Routes

| Route | What |
| --- | --- |
| `/` | Booking page: service → day → time → details → confirmation (`?code=` shows a booking and its status) |
| `/admin` | Admin: agenda, services, opening hours and days off, settings |
| `GET /api/page` | Business name and description, currency, time zone, active services, bookable dates |
| `GET /api/days?service=` | Number of free times on each bookable day |
| `GET /api/slots?service=&date=` | Free start times of one day (`HH:MM`) |
| `POST /api/bookings` | Book: `{ service, date, time, name, email, phone?, note? }` → `{ booking }` (409 `slot_taken`) |
| `GET /api/bookings/:code` | A booking by its code (no contact details); `/api/bookings/:code.ics` is its calendar file |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` | Admin session |
| `GET /api/admin/stats` | Bookings today, in the next 7 days and pending |
| `GET /api/admin/bookings?status=&past=` | Bookings from today (or the last 90 days with `past=1`) |
| `PATCH /api/admin/bookings/:id` | `{ status }`: confirm, cancel or restore (restoring checks the time is still free) |
| `GET /api/admin/bookings.csv` | CSV export of every booking |
| `GET/POST /api/admin/services`, `PUT/DELETE /api/admin/services/:id` | Services |
| `PUT /api/admin/services/order` | `{ ids }`: the services' order on the page |
| `GET/PUT /api/admin/availability` | Weekly opening hours (several ranges per weekday) and upcoming days off |
| `POST /api/admin/days-off`, `DELETE /api/admin/days-off/:date` | Days off |
| `GET/PUT /api/admin/settings` | Name, description, time zone, currency, slot step, notice, days ahead, auto-confirm |

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars   # sets ADMIN_PASSWORD for local development
npx wrangler d1 migrations apply DB --local && npx wrangler dev
```

Schema changes go in a new file in `migrations/` (for example `0002_add_staff.sql`); deploys apply them.

## Ideas to ask the agent

- Send a confirmation and a reminder the day before by email (with Resend or another email API) or WhatsApp.
- Give customers a link to cancel or reschedule their own booking, up to a few hours before.
- Support several staff members, each with their own hours, and let customers pick who they want.
- Sync the agenda with Google Calendar, so bookings show up there and busy times block slots.
- Ask for a deposit with a payment link (Pix, Stripe or Mercado Pago) before confirming.
