require("dotenv").config();
const { MongoClient } = require("mongodb");

console.log("Test file started");

const uri = process.env.MONGODB_URI;
console.log("URI found:", !!uri);

async function run() {
  let client;

  try {
    console.log("Trying to connect...");
    client = new MongoClient(uri);

    await client.connect();
    console.log("✅ MongoDB connected successfully");

    const db = client.db("contentiq");
    const result = await db.command({ ping: 1 });
    console.log("✅ Ping result:", result);
  } catch (err) {
    console.error("❌ Error:");
    console.error(err);
  } finally {
    if (client) {
      await client.close();
      console.log("Connection closed");
    }
  }
}

run();


