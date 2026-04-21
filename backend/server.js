// =============================================
// ContentIQ — Main Backend Server (server.js)
// Express + MongoDB + JWT Authentication
// =============================================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ── MongoDB Connection ────────────────────────
let db;
const client = new MongoClient(process.env.MONGODB_URI);

async function connectDB() {
  try {
    await client.connect();
    db = client.db(process.env.DB_NAME || "contentiq");
    console.log("✅ Connected to MongoDB:", process.env.DB_NAME || "contentiq");

    // Create indexes for performance and uniqueness
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    await db.collection("topics").createIndex({ user_id: 1, week: -1 });
    await db.collection("posts").createIndex({ user_id: 1, generated_at: -1 });
    await db.collection("schedules").createIndex({ user_id: 1 }, { unique: true });
    console.log("✅ Database indexes created");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

// ── JWT Auth Middleware ───────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { user_id, email, first, last }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized: Invalid token" });
  }
}

// =============================================
// AUTH ROUTES
// =============================================

// POST /api/auth/register — Create new user account
app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password, first, last, timezone } = req.body;
    if (!email || !password || !first || !last) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Check if user already exists
    const existing = await db.collection("users").findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 12);

    // Insert new user with default empty config
    const result = await db.collection("users").insertOne({
      email: email.toLowerCase(),
      password_hash,
      first,
      last,
      timezone: timezone || "Asia/Kolkata",
      created: new Date(),
      config: {
        leader_name: `${first} ${last}`,
        linkedin_url: "",
        company_website: "",
        notify_email: email.toLowerCase(),
        target_service: "",
        target_region: "",
        icp_description: "",
        icp_titles: "",
        competitor_handles: "",
        blacklist_topics: "",
        voice_hook_style: "",
        voice_sentence_len: "",
        voice_opinion_density: "",
        voice_vocabulary: "",
        voice_cta_pattern: "",
        n8n_webhook_url: "",
        schedule_day: "1",     // 1 = Monday
        schedule_time: "07:00",
      },
    });

    res.status(201).json({ message: "Account created successfully", user_id: result.insertedId });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error during registration" });
  }
});

// POST /api/auth/login — Login and receive JWT token
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = await db.collection("users").findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Generate JWT token valid for 7 days
    const token = jwt.sign(
      { user_id: user._id.toString(), email: user.email, first: user.first, last: user.last },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    res.json({
      token,
      user: {
        user_id: user._id.toString(),
        email: user.email,
        first: user.first,
        last: user.last,
        timezone: user.timezone,
        config: user.config,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error during login" });
  }
});

// GET /api/auth/me — Get current user profile
app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const user = await db.collection("users").findOne(
      { _id: new ObjectId(req.user.user_id) },
      { projection: { password_hash: 0 } } // Never return password hash
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// =============================================
// USER CONFIG ROUTES
// =============================================

// GET /api/config — Get user's n8n config
app.get("/api/config", authMiddleware, async (req, res) => {
  try {
    const user = await db.collection("users").findOne(
      { _id: new ObjectId(req.user.user_id) },
      { projection: { config: 1, timezone: 1 } }
    );
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ config: user.config, timezone: user.timezone });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch config" });
  }
});

// PUT /api/config — Update user's n8n config
app.put("/api/config", authMiddleware, async (req, res) => {
  try {
    const { config, timezone } = req.body;

    // Calculate UTC cron expression from user's local time + timezone
    const utcCron = calculateUTCCron(config.schedule_day, config.schedule_time, timezone);

    await db.collection("users").updateOne(
      { _id: new ObjectId(req.user.user_id) },
      {
        $set: {
          config: { ...config, utc_cron: utcCron },
          timezone: timezone || "Asia/Kolkata",
          updated_at: new Date(),
        },
      }
    );

    res.json({ message: "Config updated successfully", utc_cron: utcCron });
  } catch (err) {
    console.error("Config update error:", err);
    res.status(500).json({ error: "Failed to update config" });
  }
});

// Helper: Convert local schedule to UTC cron expression
function calculateUTCCron(dayOfWeek, localTime, timezone) {
  try {
    const [hour, minute] = localTime.split(":").map(Number);
    // Get timezone offset in hours using Intl API
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const utcFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      hour: "numeric",
      hour12: false,
    });
    const localHour = parseInt(formatter.format(now));
    const utcHour = parseInt(utcFormatter.format(now));
    const offset = localHour - utcHour;

    let utcHourVal = hour - offset;
    let utcDay = parseInt(dayOfWeek);

    // Handle day rollover
    if (utcHourVal < 0) { utcHourVal += 24; utcDay = (utcDay - 1 + 7) % 7; }
    if (utcHourVal >= 24) { utcHourVal -= 24; utcDay = (utcDay + 1) % 7; }

    return `${minute} ${utcHourVal} * * ${utcDay}`;
  } catch {
    return `0 1 * * 1`; // Default: Monday 1AM UTC
  }
}

// =============================================
// TOPICS ROUTES
// =============================================

// GET /api/topics — Get all topics for logged-in user
app.get("/api/topics", authMiddleware, async (req, res) => {
  try {
    const { week, status } = req.query;
    const filter = { user_id: req.user.user_id };
    if (week) filter.week = week;
    if (status) filter.status = status;

    const topics = await db.collection("topics")
      .find(filter)
      .sort({ rank: 1, created_at: -1 })
      .toArray();

    res.json(topics);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch topics" });
  }
});

// PATCH /api/topics/:id/greenlight — Toggle green light approval
app.patch("/api/topics/:id/greenlight", authMiddleware, async (req, res) => {
  try {
    const { GREEN_LIGHT } = req.body;
    const result = await db.collection("topics").updateOne(
      { _id: new ObjectId(req.params.id), user_id: req.user.user_id },
      { $set: { GREEN_LIGHT: Boolean(GREEN_LIGHT), status: GREEN_LIGHT ? "APPROVED" : "PENDING" } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: "Topic not found" });
    res.json({ message: "Green light updated", GREEN_LIGHT });
  } catch (err) {
    res.status(500).json({ error: "Failed to update topic" });
  }
});

// PATCH /api/topics/:id/reject — Reject a topic
app.patch("/api/topics/:id/reject", authMiddleware, async (req, res) => {
  try {
    await db.collection("topics").updateOne(
      { _id: new ObjectId(req.params.id), user_id: req.user.user_id },
      { $set: { GREEN_LIGHT: false, status: "REJECTED" } }
    );
    res.json({ message: "Topic rejected" });
  } catch (err) {
    res.status(500).json({ error: "Failed to reject topic" });
  }
});

// =============================================
// POSTS ROUTES
// =============================================

// GET /api/posts — Get generated posts for logged-in user
app.get("/api/posts", authMiddleware, async (req, res) => {
  try {
    const { week } = req.query;
    const filter = { user_id: req.user.user_id };
    if (week) filter.week = week;

    const posts = await db.collection("posts")
      .find(filter)
      .sort({ generated_at: -1 })
      .toArray();

    res.json(posts);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

// =============================================
// N8N TRIGGER ROUTE
// =============================================

// POST /api/trigger — Manually trigger n8n workflow for this user
app.post("/api/trigger", authMiddleware, async (req, res) => {
  try {
    // Fetch full user config to send to n8n
    const user = await db.collection("users").findOne(
      { _id: new ObjectId(req.user.user_id) },
      { projection: { password_hash: 0 } }
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    const webhookUrl = user.config?.n8n_webhook_url;
    if (!webhookUrl) {
      return res.status(400).json({ error: "No n8n webhook URL configured. Please set it in Profile Config." });
    }

    // Send user config as payload to n8n webhook
    const payload = {
      user_id: user._id.toString(),
      trigger: "manual",
      triggered_at: new Date().toISOString(),
      config: user.config,
      timezone: user.timezone,
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`n8n returned HTTP ${response.status}`);
    }

    res.json({ message: "Workflow triggered successfully", triggered_at: payload.triggered_at });
  } catch (err) {
    console.error("Trigger error:", err);
    res.status(500).json({ error: `Failed to trigger workflow: ${err.message}` });
  }
});

// =============================================
// STATS ROUTE (Dashboard summary)
// =============================================

// GET /api/stats — Get summary stats for the dashboard
app.get("/api/stats", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const [topicsTotal, topicsApproved, postsTotal, postsRecommended] = await Promise.all([
      db.collection("topics").countDocuments({ user_id: userId }),
      db.collection("topics").countDocuments({ user_id: userId, GREEN_LIGHT: true }),
      db.collection("posts").countDocuments({ user_id: userId }),
      db.collection("posts").countDocuments({ user_id: userId, recommended: true }),
    ]);

    // Latest 5 topics for activity feed
    const recentTopics = await db.collection("topics")
      .find({ user_id: userId })
      .sort({ created_at: -1 })
      .limit(5)
      .toArray();

    res.json({
      topics_total: topicsTotal,
      topics_approved: topicsApproved,
      posts_total: postsTotal,
      posts_recommended: postsRecommended,
      approval_rate: topicsTotal > 0 ? Math.round((topicsApproved / topicsTotal) * 100) : 0,
      recent_topics: recentTopics,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ── Health Check ──────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "ContentIQ Backend", timestamp: new Date().toISOString() });
});

// ── Start Server ──────────────────────────────
connectDB().then(() => {
  // Register n8n internal routes (called by n8n workflow, not the browser)
  require("./n8n_routes")(app, db);

  app.listen(PORT, () => {
    console.log(`🚀 ContentIQ Backend running on http://localhost:${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
  });
});
