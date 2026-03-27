const oracledb = require("oracledb");

const dbConfig = {
  user: "system",   // e.g. system or your schema name
  password: "24BIT0229",
  connectString: "localhost:1521/XE"
};

async function connectDB() {
  try {
    const connection = await oracledb.getConnection(dbConfig);
    console.log("Connected to Oracle DB ✅");
    return connection;
  } catch (err) {
    console.error("DB ERROR:", err);
    throw err; // 🔥 important
  }
}

module.exports = connectDB;