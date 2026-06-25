/**
 * probe-susep-rep.js  (GitHub Actions - teste de monitoramento de PDFs)
 * Agora o teste mira as CONDICOES GERAIS publicadas pelas seguradoras
 * (PDFs diretos), para confirmar:
 *   1) se a nuvem do GitHub consegue baixar (sem bloqueio);
 *   2) quais "pistas de mudanca" o servidor entrega (Last-Modified, ETag,
 *      tamanho) + uma impressao digital (hash) do arquivo.
 * Nao precisa do campo "processo" desta vez (pode digitar qualquer coisa).
 * Sempre gera saida-probe/relatorio.json e termina verde.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const OUT = path.join(process.cwd(), "saida-probe");
fs.mkdirSync(OUT, { recursive: true });

// Enderecos de condicoes gerais da Porto (candidatos a monitorar)
const ALVOS = [
  { nome: "Porto - CG Auto (institucional)", url: "https://www.portoseguro.com.br/content/dam/documentos-institicional-porto-seguro/condicoes-gerais-porto.pdf" },
  { nome: "Porto - CG Auto Frota Tradicional 2025", url: "https://www.portoseguro.com.br/content/dam/documentos/condicoes_gerais/seguro_auto_para_empresas/seguro_auto_frota/2025/CG-Frota-Tradicional-V50-Jan-25.pdf" },
  { nome: "Porto - CG66 Auto (legado)", url: "https://www.portoseguro.com.br/NovoInstitucional/static_files/CGs/auto/CG66%20Oficial%20ABRL18.pdf" },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const report = { rodadoEm: new Date().toISOString(), itens: [], erros: [] };
const writeReport = () => fs.writeFileSync(path.join(OUT, "relatorio.json"), JSON.stringify(report, null, 2));

process.on("unhandledRejection", (e) => { report.erros.push("unhandledRejection: " + (e && e.stack || e)); writeReport(); process.exit(0); });
process.on("uncaughtException", (e) => { report.erros.push("uncaughtException: " + (e && e.stack || e)); writeReport(); process.exit(0); });

(async () => {
  let i = 0;
  for (const alvo of ALVOS) {
    i++;
    const item = { nome: alvo.nome, url: alvo.url };
    try {
      console.log("• Baixando:", alvo.nome);
      const resp = await fetch(alvo.url, { headers: { "User-Agent": UA }, redirect: "follow" });
      item.status = resp.status;
      item.contentType = resp.headers.get("content-type");
      item.contentLength = resp.headers.get("content-length");
      item.lastModified = resp.headers.get("last-modified"); // data da ultima modificacao
      item.etag = resp.headers.get("etag");                  // "impressao digital" do servidor

      const buf = Buffer.from(await resp.arrayBuffer());
      item.bytesBaixados = buf.length;
      item.sha256 = crypto.createHash("sha256").update(buf).digest("hex"); // nossa impressao digital
      item.pareceePdf = buf.slice(0, 5).toString("latin1") === "%PDF-"; // confere se e PDF mesmo

      // salva o 1o PDF como prova
      if (i === 1 && item.pareceePdf) {
        fs.writeFileSync(path.join(OUT, "amostra-porto.pdf"), buf);
        item.salvoComo = "amostra-porto.pdf";
      }
      console.log("   status", item.status, "| bytes", item.bytesBaixados, "| pdf?", item.pareceePdf);
    } catch (e) {
      item.erro = (e && e.message) || String(e);
      console.log("   ERRO:", item.erro);
    }
    report.itens.push(item);
  }
  writeReport();
  console.log("• Relatorio salvo. Fim.");
  process.exit(0);
})();
