// =============================================
// ContentIQ — n8n Internal API Routes (n8n_routes.js)
// These endpoints are called BY n8n workflow, not by the frontend.
// Protected by a shared secret (N8N_INTERNAL_SECRET in .env)
// =============================================

const { ObjectId } = require("mongodb");

function n8nAuthMiddleware(req, res, next) {
  const secret = req.headers["x-n8n-secret"];
  if (!secret || secret !== process.env.N8N_INTERNAL_SECRET) {
    return res.status(403).json({ error: "Forbidden: Invalid n8n secret" });
  }
  next();
}

module.exports = function (app, db) {
  // POST /api/n8n/config
  app.post("/api/n8n/config", n8nAuthMiddleware, async (req, res) => {
    try {
      const { user_id } = req.body;
      if (!user_id) return res.status(400).json({ error: "user_id required" });
      const user = await db.collection("users").findOne(
        { _id: new ObjectId(user_id) },
        { projection: { password_hash: 0 } }
      );
      if (!user) return res.status(404).json({ error: "User not found" });
      res.json({ user_id: user._id.toString(), timezone: user.timezone, config: user.config });
    } catch (err) {
      console.error("n8n config route error:", err);
      res.status(500).json({ error: "Failed to fetch user config" });
    }
  });

  // POST /api/n8n/topics
  app.post("/api/n8n/topics", n8nAuthMiddleware, async (req, res) => {
    try {
      const { user_id, topics } = req.body;
      if (!user_id || !Array.isArray(topics)) {
        return res.status(400).json({ error: "user_id and topics[] required" });
      }
      const week = new Date().toISOString().split("T")[0].substring(0, 10);

      // Deduplicate incoming topics by title fingerprint
      const seenTitles = new Set();
      const uniqueTopics = topics.filter((t) => {
        const title = (t.topic_title || t["A — Topic Title"] || "").trim().toLowerCase();
        if (!title || seenTitles.has(title)) return false;
        seenTitles.add(title);
        return true;
      });

      const docs = uniqueTopics.map((t) => ({
        user_id: user_id,
        topic_title: t.topic_title || t["A — Topic Title"] || "",
        post_angle: t.post_angle || "",
        content_type: t.content_type || t["B — Type"] || "FRESH",
        content_tier: t.content_tier || t["C — Tier"] || "BROAD",
        hook_type: t.hook_type || "",
        score: Number(t.score || t["F — Score"] || 0),
        icp_reason: t.icp_reason || t["D — Why It Fits ICP"] || "",
        service_hook: t.service_hook || t["E — Service Hook"] || "",
        source: t.source || "",
        source_url: t.source_url || "",
        freshness_score: t.freshness_score || 0,
        GREEN_LIGHT: false,
        status: "PENDING",
        week: week,
        rank: t.rank || 99,
        created_at: new Date(),
      }));

      await db.collection("topics").deleteMany({ user_id, week });
      const result = await db.collection("topics").insertMany(docs);
      res.json({ message: "Topics saved to MongoDB", inserted: result.insertedCount, week });
    } catch (err) {
      console.error("n8n write topics error:", err);
      res.status(500).json({ error: "Failed to write topics" });
    }
  });

  // POST /api/n8n/greenlit-topics
  app.post("/api/n8n/greenlit-topics", n8nAuthMiddleware, async (req, res) => {
    try {
      const { user_id } = req.body;
      if (!user_id) return res.status(400).json({ error: "user_id required" });
      const week = new Date().toISOString().split("T")[0].substring(0, 10);
      const topics = await db.collection("topics")
        .find({ user_id, GREEN_LIGHT: true, week })
        .sort({ rank: 1 })
        .toArray();
      res.json(topics);
    } catch (err) {
      console.error("n8n greenlit topics error:", err);
      res.status(500).json({ error: "Failed to fetch green-lit topics" });
    }
  });

  // POST /api/n8n/posts
  app.post("/api/n8n/posts", n8nAuthMiddleware, async (req, res) => {
    try {
      const { user_id, posts } = req.body;
      if (!user_id || !Array.isArray(posts)) {
        return res.status(400).json({ error: "user_id and posts[] required" });
      }
      const week = new Date().toISOString().split("T")[0].substring(0, 10);

      // Deduplicate incoming posts by topic_title — fixes n8n Merge1 double-send bug
      const seenTitles = new Set();
      const uniquePosts = posts.filter((p) => {
        const title = (p.topic_title || "").trim().toLowerCase();
        if (!title || seenTitles.has(title)) return false;
        seenTitles.add(title);
        return true;
      });

      const docs = uniquePosts.map((p) => ({
        user_id: user_id,
        topic_id: p.topic_id || null,
        topic_title: p.topic_title || "",
        content_type: p.content_type || "FRESH",
        source: p.source || "",
        v1_post: p.v1_post || p.variation_1 || "",
        v2_post: p.v2_post || p.variation_2 || "",
        v3_post: p.v3_post || p.variation_3 || "",
        final_post: p.final_post || p.recommended_post || "",
        overall_quality: p.overall_quality || "Pass",
        recommended: Boolean(p.recommended),
        recommended_reason: p.recommended_reason || "",
        qc_note: p.qc_note || "",
        week: week,
        generated_at: new Date(),
      }));

      // Delete existing posts for this user+week before inserting fresh ones
      await db.collection("posts").deleteMany({ user_id, week });
      const result = await db.collection("posts").insertMany(docs);

      res.json({ message: "Posts saved to MongoDB", inserted: result.insertedCount, week, deduplicated: posts.length - uniquePosts.length });
    } catch (err) {
      console.error("n8n write posts error:", err);
      res.status(500).json({ error: "Failed to write posts" });
    }
  });

  // GET /api/n8n/all-users
  app.get("/api/n8n/all-users", n8nAuthMiddleware, async (req, res) => {
    try {
      const users = await db.collection("users").find({}, {
        projection: {
          password_hash: 0,
          "config.n8n_webhook_url": 1,
          "config.schedule_day": 1,
          "config.schedule_time": 1,
          "config.utc_cron": 1,
          timezone: 1,
          email: 1,
          first: 1,
          last: 1,
        },
      }).toArray();

      res.json(users.map((u) => ({
        user_id: u._id.toString(),
        email: u.email,
        name: `${u.first} ${u.last}`,
        timezone: u.timezone,
        utc_cron: u.config?.utc_cron || "0 1 * * 1",
        schedule_day: u.config?.schedule_day || "1",
        schedule_time: u.config?.schedule_time || "07:00",
      })));
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });
};
