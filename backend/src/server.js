const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "../../frontend")));

const PORT = process.env.PORT || 3000;
const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || "soneda_dashboard";

const client = new MongoClient(uri);

// ─────────────────────────────────────────
// UPLOAD
// ─────────────────────────────────────────
const upload = multer({ dest: "uploads/" });

// ─────────────────────────────────────────
// AUTH (LOGIN ADM)
// ─────────────────────────────────────────
const sessoes = new Map();
const TOKEN_EXPIRY_MS = 8 * 60 * 60 * 1000;

function gerarToken() {
  return crypto.randomBytes(32).toString("hex");
}

function verificarToken(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token || !sessoes.has(token)) {
    return res.status(401).json({ erro: "Não autorizado." });
  }

  const sessao = sessoes.get(token);

  if (Date.now() > sessao.expira) {
    sessoes.delete(token);
    return res.status(401).json({ erro: "Sessão expirada." });
  }

  req.usuario = sessao.usuario;
  next();
}

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
function limparValor(valor) {
  if (valor === undefined || valor === null) return "";
  return String(valor).trim();
}

function gerarIdImportacao() {
  const agora = new Date();
  const data = agora.toISOString().slice(0, 10).replace(/-/g, "");
  const hora = agora.toISOString().slice(11, 19).replace(/:/g, "");
  const aleatorio = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `IMP-${data}-${hora}-${aleatorio}`;
}

function removerArquivoTemporario(caminho) {
  if (caminho && fs.existsSync(caminho)) {
    fs.unlinkSync(caminho);
  }
}

// ─────────────────────────────────────────
// SERVIDOR
// ─────────────────────────────────────────
async function iniciarServidor() {
  try {
    await client.connect();
    const db = client.db(dbName);

    console.log("✅ Conectado ao MongoDB");
    console.log(`📦 Banco em uso: ${dbName}`);

    app.get("/", (req, res) => {
      res.sendFile(path.join(__dirname, "../../frontend/index.html"));
    });

    // ─────────────────────────────────────
    // LOGIN / LOGOUT
    // ─────────────────────────────────────
    app.post("/api/login", (req, res) => {
      const { usuario, senha } = req.body;

      if (
        usuario === process.env.ADMIN_USER &&
        senha === process.env.ADMIN_PASSWORD
      ) {
        const token = gerarToken();
        sessoes.set(token, {
          usuario,
          expira: Date.now() + TOKEN_EXPIRY_MS
        });

        return res.json({ token, usuario });
      }

      res.status(401).json({ erro: "Usuário ou senha inválidos." });
    });

    app.post("/api/logout", (req, res) => {
      const auth = req.headers.authorization || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

      if (token) sessoes.delete(token);

      res.json({ ok: true });
    });

    // ─────────────────────────────────────
    // CONSULTAS
    // ─────────────────────────────────────
    app.get("/api/dados-brutos", async (req, res) => {
      const dados = await db.collection("dados_brutos").find({}).toArray();
      res.json(dados);
    });

    app.get("/api/lojas-depara", async (req, res) => {
      const dados = await db.collection("lojas_depara").find({}).toArray();
      res.json(dados);
    });

    app.get("/api/categorias-depara", async (req, res) => {
      const dados = await db.collection("categorias_depara").find({}).toArray();
      res.json(dados);
    });

    // ─────────────────────────────────────
    // DADOS TRATADOS (JOIN)
    // ─────────────────────────────────────
    app.get("/api/dados-tratados", async (req, res) => {
      try {
        const dados = await db.collection("dados_brutos").aggregate([
          {
            $lookup: {
              from: "categorias_depara",
              localField: "GTIN/PLU",
              foreignField: "CODBARRAS",
              as: "categoria_info"
            }
          },
          {
            $lookup: {
              from: "lojas_depara",
              localField: "Loja",
              foreignField: "Cod_Loja",
              as: "loja_info"
            }
          },
          {
            $addFields: {
              Categoria_DePara: { $arrayElemAt: ["$categoria_info.CATEGORIA", 0] },
              Familia_DePara: { $arrayElemAt: ["$categoria_info.FAMILIA", 0] },
              Produto_DePara: { $arrayElemAt: ["$categoria_info.NOME PRODUTO", 0] },
              Nome_Loja_DePara: { $arrayElemAt: ["$loja_info.Nome_Fantasia", 0] }
            }
          },
          {
            $project: {
              categoria_info: 0,
              loja_info: 0
            }
          }
        ]).toArray();

        res.json(dados);
      } catch (error) {
        res.status(500).json({
          erro: "Erro ao buscar dados tratados",
          detalhe: error.message
        });
      }
    });

    // ─────────────────────────────────────
    // HISTÓRICO DE IMPORTAÇÕES (PROTEGIDO)
    // ─────────────────────────────────────
    async function registrarLogImportacao({
      importacaoId,
      tipo,
      colecao,
      arquivo,
      usuario,
      total,
      substituiColecao
    }) {
      await db.collection("importacoes_log").insertOne({
        importacao_id: importacaoId,
        tipo,
        colecao,
        arquivo_original: arquivo,
        usuario,
        total_registros: total,
        substitui_colecao: Boolean(substituiColecao),
        criado_em: new Date()
      });
    }

    app.get("/api/importacoes", verificarToken, async (req, res) => {
      try {
        const dados = await db
          .collection("importacoes_log")
          .find({})
          .sort({ criado_em: -1 })
          .limit(100)
          .toArray();

        res.json(dados);
      } catch (error) {
        res.status(500).json({
          erro: "Erro ao buscar histórico de importações",
          detalhe: error.message
        });
      }
    });

    app.delete("/api/importacoes/:importacaoId", verificarToken, async (req, res) => {
      try {
        const { importacaoId } = req.params;

        const log = await db.collection("importacoes_log").findOne({
          importacao_id: importacaoId
        });

        if (!log) {
          return res.status(404).json({ erro: "Importação não encontrada." });
        }

        const colecoesPermitidas = ["dados_brutos", "categorias_depara", "lojas_depara"];
        if (!colecoesPermitidas.includes(log.colecao)) {
          return res.status(400).json({ erro: "Coleção inválida para exclusão." });
        }

        const resultado = await db.collection(log.colecao).deleteMany({
          importacao_id: importacaoId
        });

        await db.collection("importacoes_log").updateOne(
          { importacao_id: importacaoId },
          {
            $set: {
              excluido: true,
              excluido_por: req.usuario,
              excluido_em: new Date(),
              registros_excluidos: resultado.deletedCount
            }
          }
        );

        res.json({
          mensagem: "Importação excluída do banco",
          importacao_id: importacaoId,
          registros_excluidos: resultado.deletedCount
        });
      } catch (error) {
        res.status(500).json({
          erro: "Erro ao excluir importação",
          detalhe: error.message
        });
      }
    });

    // ─────────────────────────────────────
    // IMPORTAÇÕES (PROTEGIDAS)
    // ─────────────────────────────────────
    app.post(
      "/api/importar/dados-brutos",
      verificarToken,
      upload.single("file"),
      async (req, res) => {
        const resultados = [];

        if (!req.file) {
          return res.status(400).json({ erro: "Nenhum arquivo enviado." });
        }

        const importacaoId = gerarIdImportacao();
        const importadoEm = new Date();
        const arquivoOriginal = req.file.originalname || "arquivo.csv";

        fs.createReadStream(req.file.path)
          .pipe(csv({ separator: ";" }))
          .on("data", (linha) => {
            const registro = {};

            Object.keys(linha).forEach((coluna) => {
              const nomeColuna = limparValor(coluna);
              registro[nomeColuna] = limparValor(linha[coluna]);
            });

            registro.importacao_id = importacaoId;
            registro.importado_por = req.usuario;
            registro.importado_em = importadoEm;
            registro.arquivo_original = arquivoOriginal;
            registro.tipo_importacao = "dados_brutos";

            resultados.push(registro);
          })
          .on("end", async () => {
            try {
              if (resultados.length > 0) {
                await db.collection("dados_brutos").insertMany(resultados);
              }

              await registrarLogImportacao({
                importacaoId,
                tipo: "Dados Brutos",
                colecao: "dados_brutos",
                arquivo: arquivoOriginal,
                usuario: req.usuario,
                total: resultados.length,
                substituiColecao: false
              });

              removerArquivoTemporario(req.file.path);

              res.json({
                mensagem: "Importação realizada 🚀",
                total: resultados.length,
                importacao_id: importacaoId
              });
            } catch (error) {
              removerArquivoTemporario(req.file.path);
              res.status(500).json({
                erro: "Erro ao finalizar importação",
                detalhe: error.message
              });
            }
          })
          .on("error", (error) => {
            removerArquivoTemporario(req.file.path);
            res.status(500).json({
              erro: "Erro ao ler CSV",
              detalhe: error.message
            });
          });
      }
    );

    app.post(
      "/api/importar/categorias-depara",
      verificarToken,
      upload.single("file"),
      async (req, res) => {
        const resultados = [];

        if (!req.file) {
          return res.status(400).json({ erro: "Nenhum arquivo enviado." });
        }

        const importacaoId = gerarIdImportacao();
        const importadoEm = new Date();
        const arquivoOriginal = req.file.originalname || "arquivo.csv";

        fs.createReadStream(req.file.path)
          .pipe(csv({ separator: ";" }))
          .on("data", (linha) => {
            const registro = {};
            Object.keys(linha).forEach((coluna) => {
              registro[coluna.trim()] = limparValor(linha[coluna]);
            });

            registro.importacao_id = importacaoId;
            registro.importado_por = req.usuario;
            registro.importado_em = importadoEm;
            registro.arquivo_original = arquivoOriginal;
            registro.tipo_importacao = "categorias_depara";

            resultados.push(registro);
          })
          .on("end", async () => {
            try {
              await db.collection("categorias_depara").deleteMany({});
              if (resultados.length > 0) {
                await db.collection("categorias_depara").insertMany(resultados);
              }

              await registrarLogImportacao({
                importacaoId,
                tipo: "De/Para Categorias",
                colecao: "categorias_depara",
                arquivo: arquivoOriginal,
                usuario: req.usuario,
                total: resultados.length,
                substituiColecao: true
              });

              removerArquivoTemporario(req.file.path);

              res.json({
                mensagem: "Categorias importadas",
                total: resultados.length,
                importacao_id: importacaoId
              });
            } catch (error) {
              removerArquivoTemporario(req.file.path);
              res.status(500).json({
                erro: "Erro ao importar categorias",
                detalhe: error.message
              });
            }
          })
          .on("error", (error) => {
            removerArquivoTemporario(req.file.path);
            res.status(500).json({
              erro: "Erro ao ler CSV",
              detalhe: error.message
            });
          });
      }
    );

    app.post(
      "/api/importar/lojas-depara",
      verificarToken,
      upload.single("file"),
      async (req, res) => {
        const resultados = [];

        if (!req.file) {
          return res.status(400).json({ erro: "Nenhum arquivo enviado." });
        }

        const importacaoId = gerarIdImportacao();
        const importadoEm = new Date();
        const arquivoOriginal = req.file.originalname || "arquivo.csv";

        fs.createReadStream(req.file.path)
          .pipe(csv({ separator: ";" }))
          .on("data", (linha) => {
            const registro = {};
            Object.keys(linha).forEach((coluna) => {
              registro[coluna.trim()] = limparValor(linha[coluna]);
            });

            registro.importacao_id = importacaoId;
            registro.importado_por = req.usuario;
            registro.importado_em = importadoEm;
            registro.arquivo_original = arquivoOriginal;
            registro.tipo_importacao = "lojas_depara";

            resultados.push(registro);
          })
          .on("end", async () => {
            try {
              await db.collection("lojas_depara").deleteMany({});
              if (resultados.length > 0) {
                await db.collection("lojas_depara").insertMany(resultados);
              }

              await registrarLogImportacao({
                importacaoId,
                tipo: "De/Para Lojas",
                colecao: "lojas_depara",
                arquivo: arquivoOriginal,
                usuario: req.usuario,
                total: resultados.length,
                substituiColecao: true
              });

              removerArquivoTemporario(req.file.path);

              res.json({
                mensagem: "Lojas importadas",
                total: resultados.length,
                importacao_id: importacaoId
              });
            } catch (error) {
              removerArquivoTemporario(req.file.path);
              res.status(500).json({
                erro: "Erro ao importar lojas",
                detalhe: error.message
              });
            }
          })
          .on("error", (error) => {
            removerArquivoTemporario(req.file.path);
            res.status(500).json({
              erro: "Erro ao ler CSV",
              detalhe: error.message
            });
          });
      }
    );

    // ─────────────────────────────────────
    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
    });

  } catch (erro) {
    console.error("❌ Erro ao iniciar servidor:", erro);
  }
}

iniciarServidor();