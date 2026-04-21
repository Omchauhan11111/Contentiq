# ContentIQ — Full Stack Setup Guide
## Multi-User LinkedIn Content Intelligence Platform

---

## Project Structure

```
contentiq_fullstack/
├── frontend/
│   ├── login.html          ← Login page (BoostUp red theme)
│   ├── register.html       ← 4-step registration wizard
│   ├── dashboard.html      ← Main dashboard (5 tabs)
│   └── logo.png            ← Your logo file
│
├── backend/
│   ├── server.js           ← Express API server (Auth + Users + Topics + Posts)
│   ├── n8n_routes.js       ← Internal routes for n8n workflow (not browser-facing)
│   ├── package.json        ← Dependencies
│   └── .env                ← Environment variables (FILL THIS FIRST)
│
├── n8n_workflow/
│   └── contentiq_n8n_workflow_v3_mongodb.json  ← Updated n8n workflow (import this)
│
└── README.md               ← This file
```

---

## Step 1 — Fill the .env File

Open `backend/.env` and fill in:

```
MONGODB_URI=mongodb+srv://dgw_user:YOUR_REAL_PASSWORD@cluster0.rwhkq91.mongodb.net/contentiq?appName=Cluster0
JWT_SECRET=any-long-random-string-min-32-chars
N8N_INTERNAL_SECRET=another-random-secret-shared-with-n8n
FRONTEND_URL=http://localhost:5500    # change to your domain when live
N8N_BASE_URL=https://your-n8n.com
PORT=3000
```

> **N8N_INTERNAL_SECRET** — this is the secret that n8n sends in the `x-n8n-secret` header when calling your backend. Set the same value in n8n environment variables.

---

## Step 2 — MongoDB Database

**Database name:** `contentiq`
**Connection string:** your Atlas URI above

The backend auto-creates these 4 collections with indexes on first start:

| Collection | Purpose | Key Fields |
|---|---|---|
| `users` | Login accounts + config | `email` (unique), `config` (all n8n settings) |
| `topics` | AI-generated topic ideas | `user_id`, `week`, `GREEN_LIGHT`, `score` |
| `posts` | Generated LinkedIn posts | `user_id`, `week`, `recommended`, `v1_post`, `v2_post`, `v3_post` |
| `schedules` | (embedded in users.config) | `schedule_day`, `schedule_time`, `utc_cron` |

**Multi-user isolation:** Every topic and post document has a `user_id` field. All queries filter by `user_id` from the JWT token, so users never see each other's data.

---

## Step 3 — Run the Backend

```bash
cd backend
npm install
node server.js
# Server starts on http://localhost:3000
```

For production:
```bash
npm install -g pm2
pm2 start server.js --name contentiq-backend
pm2 save
```

---

## Step 4 — Host the Frontend

**Local development:**
- Open `frontend/login.html` in any browser (or use VSCode Live Server)
- Make sure `API_URL` at top of each HTML file points to `http://localhost:3000`

**Production (Vercel / Netlify):**
1. Upload the `frontend/` folder
2. Change `API_URL` in all 3 HTML files to your backend URL before uploading

---

## Step 5 — Import n8n Workflow

1. Open your n8n instance
2. Go to **Workflows → Import**
3. Import `n8n_workflow/contentiq_n8n_workflow_v3_mongodb.json`
4. Set these n8n environment variables (Settings → Environment Variables):
   - `BACKEND_URL` = your backend URL (e.g. `https://your-backend.railway.app`)
   - `N8N_INTERNAL_SECRET` = same value as in `.env`
5. Re-connect your credentials: Google Gemini, Slack OAuth2, Apify

---

## Step 6 — Configure n8n Webhook URL

After importing the workflow:
1. Click the **"Webhook — Manual Trigger"** node
2. Copy the **Production URL**
3. In each user's dashboard → **Profile Config → n8n Webhook URL** → paste it

---

## What Changed in the n8n Workflow (v2 → v3)

| Old (v2) | New (v3) | Why |
|---|---|---|
| Google Sheets Config Loader | HTTP POST to `/api/n8n/config` | Per-user config from MongoDB |
| Google Sheets Write Review | HTTP POST to `/api/n8n/topics` | Saves topics with `user_id` |
| Google Sheets Fetch Green-Lit | HTTP POST to `/api/n8n/greenlit-topics` | Filters by `user_id` + `GREEN_LIGHT: true` |
| Google Sheets Write Content | HTTP POST to `/api/n8n/posts` | Saves posts with `user_id` |
| Hardcoded Slack user ID | `{{ $('Parse Leader Config').first().json.notify_email }}` | Each user gets their own notification |
| Fixed schedule trigger only | Webhook trigger + Schedule trigger | Manual trigger from dashboard works |

---

## Multi-User Flow (How It Works)

```
User registers → config saved to MongoDB users collection
                          ↓
User clicks "Run Workflow" on dashboard
                          ↓
Backend sends POST to n8n webhook with:
  { user_id, config: { leader_name, icp, voice, ... } }
                          ↓
n8n receives payload → Node 1 fetches full config from MongoDB for that user_id
                          ↓
All subsequent nodes use {{ $('Parse Leader Config').first().json.user_id }}
to tag every topic and post with that user_id
                          ↓
Dashboard fetches /api/topics?user_id=... (from JWT) → only that user's data
```

---

## Automatic Scheduling (Multi-User)

Each user sets their own schedule (day + time in their timezone).

The backend converts it to UTC cron automatically:
- Singapore Monday 7AM → `0 23 * * 0` (Sunday 11PM UTC)
- India Monday 7AM → `30 1 * * 1` (Monday 1:30AM UTC)

**Current limitation:** The n8n Schedule Trigger runs the workflow for ONE user at a time. For true multi-user auto-scheduling, the recommended approach is:

**Option A (Simple):** Each user has their own n8n workflow instance with their own cron.

**Option B (Advanced):** Add a "Loop Over Users" node in n8n that calls `/api/n8n/all-users` to get all users, then loops and processes each one.

---

## API Reference (Backend Routes)

### Auth
| Method | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Create new user |
| POST | `/api/auth/login` | Login → returns JWT token |
| GET | `/api/auth/me` | Get current user (requires token) |

### Config
| Method | Route | Description |
|---|---|---|
| GET | `/api/config` | Get user's n8n config |
| PUT | `/api/config` | Update user's n8n config |

### Topics
| Method | Route | Description |
|---|---|---|
| GET | `/api/topics` | Get user's topics |
| PATCH | `/api/topics/:id/greenlight` | Toggle green light |
| PATCH | `/api/topics/:id/reject` | Reject a topic |

### Posts
| Method | Route | Description |
|---|---|---|
| GET | `/api/posts` | Get user's generated posts |

### Workflow
| Method | Route | Description |
|---|---|---|
| POST | `/api/trigger` | Manually trigger n8n workflow |
| GET | `/api/stats` | Dashboard summary stats |

### n8n Internal (called by n8n, not browser)
| Method | Route | Header Required |
|---|---|---|
| POST | `/api/n8n/config` | `x-n8n-secret` |
| POST | `/api/n8n/topics` | `x-n8n-secret` |
| POST | `/api/n8n/greenlit-topics` | `x-n8n-secret` |
| POST | `/api/n8n/posts` | `x-n8n-secret` |
| GET | `/api/n8n/all-users` | `x-n8n-secret` |

---

## Hosting Recommendations

| Service | What to deploy | Cost |
|---|---|---|
| **Railway** | Backend (Node.js) | Free tier available |
| **Render** | Backend (Node.js) | Free tier (sleeps) |
| **Vercel** | Frontend (HTML files) | Free |
| **Netlify** | Frontend (HTML files) | Free |
| **MongoDB Atlas** | Database | Free M0 cluster |
| **n8n Cloud** | Workflow automation | Paid ($20/mo) |
| **n8n self-hosted** | On Railway/VPS | Free |
