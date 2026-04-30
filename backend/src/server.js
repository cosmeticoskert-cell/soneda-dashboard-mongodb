
const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri);

async function connectDB() {
  try {
    await client.connect();
    console.log("✅ Conectado ao MongoDB");

    const db = client.db(process.env.DB_NAME);
    app.locals.db = db;

    app.get("/", (req, res) => {
      res.send("API rodando 🚀");
    });

    app.get("/vendas", async (req, res) => {
      const vendas = await db.collection("vendas").find().toArray();
      res.json(vendas);
    });

    app.post("/vendas", async (req, res) => {
      const data = req.body;
      const result = await db.collection("vendas").insertOne(data);
      res.json(result);
    });

    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
    });

  } catch (error) {
    console.error("❌ Erro ao conectar no MongoDB:", error);
  }
}

connectDB();