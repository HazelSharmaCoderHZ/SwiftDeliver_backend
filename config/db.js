const oracledb = require("oracledb");

async function initialize() {
  try {
    await oracledb.createPool({
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      connectString: process.env.DB_CONNECT_STRING,
    });

    console.log("✅ Oracle DB Pool Created");
  } catch (err) {
    console.error("❌ DB Pool Error:", err);
  }
}

module.exports = initialize;