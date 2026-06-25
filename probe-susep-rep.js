/**
 * probe-susep-rep.js  (GitHub Actions - versao a prova de falhas)
 * Sondagem da Consulta Publica de Produtos da SUSEP (REP).
 * Garante SEMPRE gerar saida-probe/relatorio.json, mesmo se algo der errado,
 * e termina sempre com sucesso (verde) para o resultado poder ser baixado.
 */

const fs = require("fs");
const path = require("path");

const PROCESSO = process.env.PROCESSO || "";
const URL = "https://www2.susep.gov.br/safe/menumercado/REP2/Produto.aspx/Consultar";
const OUT = path.join(process.cwd(), "saida-probe");
fs.mkdirSync(OUT, { recursive: true });

const report = {
  rodadoEm: new Date().toISOString(),
  url: URL,
  processo: PROCESSO,
  rede: [],
  campos: [],
  temCaptcha: null,
  resultado: {},
  download: null,
  erros: [],
};

const log = (...a) => console.log("•", ...a);
const save = (file, content) => fs.writeFileSync(path.join(OUT, file), content);
const writeReport = () => save("relatorio.json", JSON.stringify(report, null, 2));

// marca que o script iniciou (se isto sumir, o problema e antes do node)
save("00-boot.txt", "iniciou em " + new Date().toISOString());

// rede de seguranca: qualquer erro nao tratado ainda gera relatorio e sai verde
process.on("unhandledRejection", (e) => { report.erros.push("unhandledRejection: " + (e && e.stack || e)); writeReport(); process.exit(0); });
process.on("uncaughtException", (e) => { report.erros.push("uncaughtException: " + (e && e.stack || e)); writeReport(); process.exit(0); });

(async () => {
  let browser;
  try {
    const { chromium } = require("playwright");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    page.on("request", (req) => {
      if (req.url().includes("susep.gov.br")) {
        report.rede.push({ tipo: "request", method: req.method(), url: req.url(), resourceType: req.resourceType() });
      }
    });
    page.on("response", (res) => {
      if (res.url().includes("susep.gov.br")) {
        const ct = res.headers()["content-type"] || "";
        report.rede.push({ tipo: "response", status: res.status(), url: res.url(), contentType: ct });
        if (ct.includes("pdf")) log("PDF detectado:", res.url());
      }
    });
    page.on("download", async (dl) => {
      const nome = dl.suggestedFilename() || "documento.pdf";
      const destino = path.join(OUT, nome);
      await dl.saveAs(destino).catch((e) => report.erros.push("saveAs: " + e.message));
      report.download = { via: "page.download", suggestedFilename: nome, url: dl.url() };
      log("Download capturado:", nome);
    });

    // 1) abre a tela e mapeia os campos
    log("Abrindo", URL);
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);
    save("01-tela-inicial.html", await page.content());
    await page.screenshot({ path: path.join(OUT, "01-tela-inicial.png"), fullPage: true });

    report.campos = await page.$$eval("input, select, button, textarea", (els) =>
      els.map((e) => ({
        tag: e.tagName,
        type: e.getAttribute("type"),
        id: e.id || null,
        name: e.getAttribute("name") || null,
        value: e.getAttribute("value") || null,
        placeholder: e.getAttribute("placeholder") || null,
      }))
    );
    log("Campos encontrados:", report.campos.length);

    report.temCaptcha = await page.evaluate(() => {
      const html = document.documentElement.outerHTML.toLowerCase();
      return /recaptcha|hcaptcha|captcha/.test(html);
    });
    log("Tem CAPTCHA?", report.temCaptcha);

    if (!PROCESSO) {
      report.erros.push("PROCESSO vazio.");
    } else {
      const inputSel =
        (await page.$('input[type="text"]')) ? 'input[type="text"]' :
        (await page.$("input:not([type=hidden]):not([type=submit]):not([type=button])")) ?
          "input:not([type=hidden]):not([type=submit]):not([type=button])" : null;
      if (!inputSel) throw new Error("Campo de texto nao encontrado (veja campos).");
      log("Campo:", inputSel);
      await page.fill(inputSel, PROCESSO);

      const botao =
        (await page.$('input[type="submit"][value*="Buscar" i]')) ? 'input[type="submit"][value*="Buscar" i]' :
        (await page.$('button:has-text("Buscar")')) ? 'button:has-text("Buscar")' :
        (await page.$('input[type="submit"]')) ? 'input[type="submit"]' : null;
      if (!botao) throw new Error("Botao Buscar nao encontrado (veja campos).");
      log("Botao:", botao);

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}),
        page.click(botao),
      ]);
      await page.waitForTimeout(2500);

      save("02-resultado.html", await page.content());
      await page.screenshot({ path: path.join(OUT, "02-resultado.png"), fullPage: true });

      report.resultado.textoVisivel = (await page.evaluate(() => document.body.innerText)).slice(0, 4000);
      report.resultado.tabelas = await page.$$eval("table", (ts) => ts.map((t) => t.innerText.slice(0, 2000)));
      report.resultado.links = await page.$$eval("a", (as) =>
        as.map((a) => ({ texto: (a.innerText || "").trim().slice(0, 80), href: a.href }))
          .filter((l) => /\.pdf|documento|condic|vers|download|arquivo/i.test(l.texto + " " + l.href))
      );
      log("Tabelas:", report.resultado.tabelas.length, "Links doc:", report.resultado.links.length);

      const docLink = report.resultado.links[0];
      if (docLink && docLink.href) {
        log("Abrindo documento:", docLink.texto || docLink.href);
        const [popup] = await Promise.all([
          context.waitForEvent("page", { timeout: 8000 }).catch(() => null),
          page.click(`a[href="${docLink.href}"]`).catch(() => {}),
        ]);
        await page.waitForTimeout(3000);
        if (popup) { report.download = report.download || { via: "popup", url: popup.url() }; log("Nova aba:", popup.url()); }
      } else {
        report.erros.push("Nenhum link de documento obvio (veja 02-resultado.html).");
      }
    }
  } catch (e) {
    report.erros.push("erro: " + (e && e.stack || e));
    log("ERRO:", e && e.message || e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    writeReport();
    log("Relatorio salvo. Fim.");
    process.exit(0);
  }
})();
