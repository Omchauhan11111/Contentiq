const { ObjectId } = require("mongodb");

function n8nAuthMiddleware(req, res, next) {
  const secret = req.headers["x-n8n-secret"];
  if (!secret || secret !== process.env.N8N_INTERNAL_SECRET) {
    return res.status(403).json({ error: "Forbidden: Invalid n8n secret" });
  }
  next();
}

module.exports = function (app, db) {

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
      res.status(500).json({ error: "Failed to fetch user config" });
    }
  });

  app.post("/api/n8n/topics", n8nAuthMiddleware, async (req, res) => {
    try {
      const { user_id, topics } = req.body;
      if (!user_id || !Array.isArray(topics)) {
        return res.status(400).json({ error: "user_id and topics[] required" });
      }
      const week = new Date().toISOString().split("T")[0].substring(0, 10);

      const seenTitles = new Set();
      const uniqueTopics = topics.filter((t) => {
        const title = (t.topic_title || t["A \u2014 Topic Title"] || "").trim().toLowerCase();
        if (!title || seenTitles.has(title)) return false;
        seenTitles.add(title);
        return true;
      });

      const docs = uniqueTopics.map((t) => ({
        user_id,
        topic_title: t.topic_title || t["A \u2014 Topic Title"] || "",
        post_angle: t.post_angle || "",
        content_type: t.content_type || t["B \u2014 Type"] || "FRESH",
        content_tier: t.content_tier || t["C \u2014 Tier"] || "BROAD",
        hook_type: t.hook_type || "",
        score: Number(t.score || t["F \u2014 Score"] || 0),
        icp_reason: t.icp_reason || t["D \u2014 Why It Fits ICP"] || "",
        service_hook: t.service_hook || t["E \u2014 Service Hook"] || "",
        source: t.source || "",
        source_url: t.source_url || "",
        freshness_score: t.freshness_score || 0,
        GREEN_LIGHT: false,
        status: "PENDING",
        week,
        rank: t.rank || 99,
        created_at: new Date(),
      }));

      await db.collection("topics").deleteMany({ user_id, week });
      const result = await db.collection("topics").insertMany(docs);
      res.json({ message: "Topics saved", inserted: result.insertedCount, week });
    } catch (err) {
      res.status(500).json({ error: "Failed to write topics" });
    }
  });

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
      res.status(500).json({ error: "Failed to fetch green-lit topics" });
    }
  });

  app.post("/api/n8n/posts", n8nAuthMiddleware, async (req, res) => {
    try {
      const { user_id, posts } = req.body;
      if (!user_id || !Array.isArray(posts)) {
        return res.status(400).json({ error: "user_id and posts[] required" });
      }
      const week = new Date().toISOString().split("T")[0].substring(0, 10);

      // Step 1: Deduplicate by topic_title — fixes n8n sending duplicates
      const seenTitles = new Set();
      const uniquePosts = posts.filter((p) => {
        const title = (p.topic_title || "").trim().toLowerCase();
        if (!title || seenTitles.has(title)) return false;
        seenTitles.add(title);
        return true;
      });

      // Step 2: Map fields — n8n sends v1_insight/v2_perspective/v3_framework
      const docs = uniquePosts.map((p) => ({
        user_id,
        topic_id: p.topic_id || null,
        topic_title: p.topic_title || "",
        content_type: p.content_type || "FRESH",
        source: p.source || "",
        // n8n field names mapped to DB field names
        v1_post: p.v1_insight || p.v1_post || "",
        v2_post: p.v2_perspective || p.v2_post || "",
        v3_post: p.v3_framework || p.v3_post || "",
        final_post: p.final_post || "",
        final_version: p.final_version || "none",
        overall_quality: p.overall_quality || "low",
        recommended: p.recommended || "",
        recommended_reason: p.recommended_reason || "",
        route: p.route || "review",
        v1_passed: Boolean(p.v1_passed),
        v2_passed: Boolean(p.v2_passed),
        v3_passed: Boolean(p.v3_passed),
        v1_issues: p.v1_issues || [],
        v2_issues: p.v2_issues || [],
        v3_issues: p.v3_issues || [],
        qc_note: p.qc_note || "",
        score: p.score || 0,
        week,
        generated_at: new Date(),
      }));

      await db.collection("posts").deleteMany({ user_id, week });
      const result = await db.collection("posts").insertMany(docs);

      res.json({
        message: "Posts saved",
        inserted: result.insertedCount,
        deduplicated: posts.length - uniquePosts.length,
        week
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to write posts" });
    }
  });

  app.get("/api/n8n/all-users", n8nAuthMiddleware, async (req, res) => {
    try {
      const users = await db.collection("users").find({}, {
        projection: {
          password_hash: 0,
          "config.n8n_webhook_url": 1,
          "config.schedule_day": 1,
          "config.schedule_time": 1,
          "config.utc_cron": 1,
          timezone: 1, email: 1, first: 1, last: 1,
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
