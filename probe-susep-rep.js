/**
 * probe-susep-rep.js  (versão para rodar no GitHub Actions)
 * Sondagem técnica da Consulta Pública de Produtos da SUSEP (sistema REP).
 *
 * O número do processo vem da variável de ambiente PROCESSO (preenchida
 * no campo do GitHub na hora de rodar). Roda headless (sem abrir janela).
 * Gera a pasta ./saida-probe com screenshots, HTMLs, o PDF (se houver) e
 * um relatorio.json com tudo que foi capturado.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// ===================== CONFIG =====================
const PROCESSO = process.env.PROCESSO || ""; // vem do campo preenchido no GitHub
const URL = "https://www2.susep.gov.br/safe/menumercado/REP2/Produto.aspx/Consultar";
const HEADLESS = true; // no GitHub roda sempre sem janela
const OUT = path.join(process.cwd(), "saida-probe");
// ==================================================

fs.mkdirSync(OUT, { recursive: true });

const report = {
  rodadoEm: new Date().toISOString(),
  url: URL,
  processo: PROCESSO,
  rede: [],            // requisicoes/respostas no dominio susep
  campos: [],          // inputs/selects/botoes da tela inicial
  temCaptcha: null,
  resultado: {},       // o que veio apos o Buscar
  download: null,      // dados do PDF baixado
  erros: [],
};

const log = (...a) => console.log("•", ...a);
const save = (file, content) => fs.writeFileSync(path.join(OUT, file), content);

(async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
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
      if (ct.includes("pdf")) log("PDF detectado na resposta:", res.url());
    }
  });
  page.on("download", async (dl) => {
    const nome = dl.suggestedFilename() || "documento.pdf";
    const destino = path.join(OUT, nome);
    await dl.saveAs(destino).catch((e) => report.erros.push("saveAs: " + e.message));
    report.download = { via: "page.download", suggestedFilename: nome, url: dl.url(), salvoEm: destino };
    log("Download capturado:", nome);
  });

  try {
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
    log(`Encontrados ${report.campos.length} campos.`);

    report.temCaptcha = await page.evaluate(() => {
      const html = document.documentElement.outerHTML.toLowerCase();
      return /recaptcha|hcaptcha|captcha/.test(html);
    });
    log("Tem CAPTCHA?", report.temCaptcha);

    if (!PROCESSO) {
      report.erros.push("PROCESSO vazio — preencha o campo ao rodar o workflow.");
      log("⚠ Campo PROCESSO veio vazio.");
    } else {
      // 2) preenche o no do processo
      const inputSel =
        (await page.$('input[type="text"]')) ? 'input[type="text"]' :
        (await page.$("input:not([type=hidden]):not([type=submit]):not([type=button])")) ?
          "input:not([type=hidden]):not([type=submit]):not([type=button])" : null;
      if (!inputSel) throw new Error("Nao localizei o campo de texto. Veja report.campos.");
      log("Campo de processo:", inputSel);
      await page.fill(inputSel, PROCESSO);

      // 3) clica em Buscar
      const botao =
        (await page.$('input[type="submit"][value*="Buscar" i]')) ? 'input[type="submit"][value*="Buscar" i]' :
        (await page.$('button:has-text("Buscar")')) ? 'button:has-text("Buscar")' :
        (await page.$('input[type="submit"]')) ? 'input[type="submit"]' : null;
      if (!botao) throw new Error("Nao localizei o botao Buscar. Veja report.campos.");
      log("Botao:", botao);

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}),
        page.click(botao),
      ]);
      await page.waitForTimeout(2500);

      save("02-resultado.html", await page.content());
      await page.screenshot({ path: path.join(OUT, "02-resultado.png"), fullPage: true });

      // 4) le a tabela de versoes/datas
      report.resultado.textoVisivel = (await page.evaluate(() => document.body.innerText)).slice(0, 4000);
      report.resultado.tabelas = await page.$$eval("table", (ts) => ts.map((t) => t.innerText.slice(0, 2000)));
      report.resultado.links = await page.$$eval("a", (as) =>
        as
          .map((a) => ({ texto: (a.innerText || "").trim().slice(0, 80), href: a.href }))
          .filter((l) => /\.pdf|documento|condic|vers|download|arquivo/i.test(l.texto + " " + l.href))
      );
      log(`Resultado: ${report.resultado.tabelas.length} tabela(s), ${report.resultado.links.length} link(s) de documento.`);

      // 5) tenta abrir/baixar o 1o documento
      const docLink = report.resultado.links[0];
      if (docLink && docLink.href) {
        log("Tentando abrir documento:", docLink.texto || docLink.href);
        const [maybePopup] = await Promise.all([
          context.waitForEvent("page", { timeout: 8000 }).catch(() => null),
          page.click(`a[href="${docLink.href}"]`).catch(() => {}),
        ]);
        await page.waitForTimeout(3000);
        if (maybePopup) {
          report.download = report.download || { via: "popup", url: maybePopup.url() };
          log("Abriu nova aba:", maybePopup.url());
        }
      } else {
        report.erros.push("Nenhum link de documento obvio. Veja 02-resultado.html.");
      }
    }
  } catch (e) {
    report.erros.push(e.message);
    log("ERRO:", e.message);
  } finally {
    save("relatorio.json", JSON.stringify(report, null, 2));
    log("Relatorio salvo.");
    await browser.close();
  }
})();
