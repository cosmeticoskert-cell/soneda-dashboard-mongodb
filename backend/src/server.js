require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();

app.use(cors());
app.use(express.json());

// ======================================================
// CONFIG
// ======================================================

const PORT = process.env.PORT || 3000;

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || "soneda";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "dados";

if (!MONGO_URI) {
  console.error("❌ MONGO_URI não definida.");
  process.exit(1);
}

// ======================================================
// MONGO
// ======================================================

let db;
let collection;

async function conectarMongo() {
  try {
    const client = new MongoClient(MONGO_URI);

    await client.connect();

    db = client.db(DB_NAME);
    collection = db.collection(COLLECTION_NAME);

    console.log("✅ MongoDB conectado");
  } catch (err) {
    console.error("❌ Erro ao conectar MongoDB:", err);
    process.exit(1);
  }
}

conectarMongo();

// ======================================================
// HEALTHCHECK
// ======================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    api: "Soneda Dashboard MongoDB",
  });
});

// ======================================================
// DADOS BRUTOS OTIMIZADO
// ======================================================

app.get("/api/dados-brutos", async (req, res) => {
  try {
    const limite = Number(req.query.limite || 5000);

    const dados = await collection
      .find({})
      .limit(limite)
      .toArray();

    res.json(dados);
  } catch (err) {
    console.error("❌ Erro /api/dados-brutos:", err);

    res.status(500).json({
      erro: "Erro ao buscar dados",
    });
  }
});

// ======================================================
// RESUMO DASHBOARD
// ======================================================

app.get("/api/dashboard/resumo", async (req, res) => {
  try {
    const pipeline = [
      {
        $group: {
          _id: null,

          total_vendido: {
            $sum: {
              $ifNull: ["$Venda (Qtd)", 0],
            },
          },

          total_valor: {
            $sum: {
              $ifNull: ["$Venda (R$)", 0],
            },
          },

          lojas: {
            $addToSet: "$Loja",
          },
        },
      },
      {
        $project: {
          _id: 0,

          total_vendido: 1,

          total_valor: 1,

          total_lojas: {
            $size: "$lojas",
          },
        },
      },
    ];

    const resultado = await collection.aggregate(pipeline).toArray();

    res.json(
      resultado[0] || {
        total_vendido: 0,
        total_valor: 0,
        total_lojas: 0,
      }
    );
  } catch (err) {
    console.error("❌ Erro /api/dashboard/resumo:", err);

    res.status(500).json({
      erro: "Erro ao gerar resumo",
    });
  }
});

// ======================================================
// SELL OUT OTIMIZADO
// ======================================================

app.get("/api/vendas-sellout", async (req, res) => {
  try {
    const {
      dataInicio,
      dataFim,
      loja,
      categoria,
      limite,
    } = req.query;

    let filtro = {};

    // ------------------------------------------
    // FILTRO DATA
    // ------------------------------------------

    if (dataInicio || dataFim) {
      filtro["Data"] = {};

      if (dataInicio) {
        filtro["Data"]["$gte"] = dataInicio;
      }

      if (dataFim) {
        filtro["Data"]["$lte"] = dataFim;
      }
    }

    // ------------------------------------------
    // FILTRO LOJA
    // ------------------------------------------

    if (loja) {
      filtro["Loja"] = loja;
    }

    // ------------------------------------------
    // FILTRO CATEGORIA
    // ------------------------------------------

    if (categoria) {
      filtro["Categoria"] = categoria;
    }

    // ------------------------------------------
    // LIMITE
    // ------------------------------------------

    const maxLimite = Number(limite || 1000);

    // ------------------------------------------
    // QUERY
    // ------------------------------------------

    const dados = await collection
      .find(filtro)
      .project({
        _id: 0,
      })
      .limit(maxLimite)
      .toArray();

    res.json(dados);
  } catch (err) {
    console.error("❌ Erro /api/vendas-sellout:", err);

    res.status(500).json({
      erro: "Erro ao carregar sell out",
    });
  }
});

// ======================================================
// SELL OUT AGRUPADO
// ======================================================

app.get("/api/vendas-sellout/resumo", async (req, res) => {
  try {
    const pipeline = [
      {
        $group: {
          _id: "$Categoria",

          quantidade: {
            $sum: {
              $ifNull: ["$Venda (Qtd)", 0],
            },
          },

          valor: {
            $sum: {
              $ifNull: ["$Venda (R$)", 0],
            },
          },
        },
      },

      {
        $sort: {
          valor: -1,
        },
      },

      {
        $limit: 20,
      },
    ];

    const resultado = await collection.aggregate(pipeline).toArray();

    res.json(resultado);
  } catch (err) {
    console.error("❌ Erro /api/vendas-sellout/resumo:", err);

    res.status(500).json({
      erro: "Erro resumo sell out",
    });
  }
});

// ======================================================
// TOP PRODUTOS
// ======================================================

app.get("/api/top-produtos", async (req, res) => {
  try {
    const pipeline = [
      {
        $group: {
          _id: "$Produto",

          quantidade: {
            $sum: {
              $ifNull: ["$Venda (Qtd)", 0],
            },
          },

          valor: {
            $sum: {
              $ifNull: ["$Venda (R$)", 0],
            },
          },
        },
      },

      {
        $sort: {
          valor: -1,
        },
      },

      {
        $limit: 30,
      },
    ];

    const resultado = await collection.aggregate(pipeline).toArray();

    res.json(resultado);
  } catch (err) {
    console.error("❌ Erro /api/top-produtos:", err);

    res.status(500).json({
      erro: "Erro top produtos",
    });
  }
});

// ======================================================
// INICIAR
// ======================================================

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});