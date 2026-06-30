const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(OUT_DIR, "pizza-snapshot.json");
const OUT_JS_FILE = path.join(OUT_DIR, "pizza-snapshot.js");

const PAPA_DEFAULT_URL = "https://papajohns.ru/moscow";
const DODO_DEFAULT_URL = "https://dodopizza.ru/moscow/veshnyaki";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const clean = arg.replace(/^--/, "");
    const eqIndex = clean.indexOf("=");
    return eqIndex >= 0 ? [clean.slice(0, eqIndex), clean.slice(eqIndex + 1)] : [clean, "true"];
  }),
);

const source = args.get("source") || "all";
const dodoLimit = Number(args.get("dodo-limit") || 0);
const dodoHeaded = args.get("headed") === "true";
const PAPA_URL = args.get("papa-url") || process.env.PAPA_URL || PAPA_DEFAULT_URL;

function normalizeDodoMenuUrl(value) {
  const url = new URL(value || DODO_DEFAULT_URL);
  const productIndex = url.pathname.indexOf("/product/");
  if (productIndex >= 0) {
    url.pathname = url.pathname.slice(0, productIndex).replace(/\/$/, "");
    url.search = "";
    url.hash = "";
  }
  return url.toString().replace(/\/$/, "");
}

const DODO_URL = normalizeDodoMenuUrl(args.get("dodo-url") || process.env.DODO_URL || DODO_DEFAULT_URL);

function parseRub(text) {
  const match = String(text || "")
    .replace(/[\u202f\u00a0]/g, " ")
    .match(/(\d[\d ]*)\s*₽/);
  return match ? Number(match[1].replace(/\s/g, "")) : null;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
}

function extractWeight(variation) {
  const value = variation?.characteristics?.find((item) => item.code === "weight")?.value;
  return value == null ? null : Number(String(value).replace(/[^\d.]/g, ""));
}

function parseVariantLine(line) {
  const text = String(line || "").replace(/\s+/g, " ").trim();
  const sizeMatch = text.match(/(\d+)\s*см/i);
  const weightMatch = text.match(/(\d+)\s*г/i);
  const dough = /тонк/i.test(text) ? "Тонкое" : /традиц/i.test(text) ? "Традиционное" : null;
  return {
    sizeCm: sizeMatch ? Number(sizeMatch[1]) : null,
    dough,
    weightG: weightMatch ? Number(weightMatch[1]) : null,
    raw: text,
  };
}

function isStandardPapaCrust(variation) {
  return (variation.stuffed_crust || variation.crust || "none") === "none";
}

function isHalfPizzaProduct(name) {
  return /половин/i.test(normalizeName(name));
}

function pickPapaVariant(variations, sizeCm, dough, crust = "none") {
  const normalizedCrust = crust || "none";
  const itemSize = (item) => item.size?.value ?? item.sizeCm ?? item.diameter ?? null;
  const itemCrust = (item) => item.stuffed_crust ?? item.crust ?? "none";
  const itemDough = (item) => item.dough ?? item.kind?.dough ?? null;
  return (
    variations.find((item) => itemSize(item) === sizeCm && itemCrust(item) === normalizedCrust && itemDough(item) === dough) ||
    variations.find((item) => itemSize(item) === sizeCm && itemCrust(item) === normalizedCrust) ||
    null
  );
}

async function collectPapa() {
  const response = await fetch(PAPA_URL, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    },
  });
  if (!response.ok) {
    throw new Error(`Papa Johns HTTP ${response.status}`);
  }

  const html = await response.text();
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .find((content) => content.startsWith("window.__PRELOADED_STATE__="));

  if (!script) {
    throw new Error("Papa Johns preloaded state not found");
  }

  const sandbox = { window: {} };
  vm.runInNewContext(script, sandbox, { timeout: 5000 });
  const state = sandbox.window.__PRELOADED_STATE__;
  const products = state.catalog.products.list.filter(
    (item) => item.category === "pizza" && !isHalfPizzaProduct(item.name),
  );

  return products.map((product) => {
    const variations = (product.variations || [])
      .filter((variation) => Number.isFinite(variation.price) && variation.price > 50 && isStandardPapaCrust(variation))
      .map((variation) => ({
        id: String(variation.id),
        sizeCm: variation.size?.value ?? variation.diameter ?? null,
        dough: variation.dough || variation.kind?.dough || null,
        crust: variation.stuffed_crust || "none",
        price: variation.price,
        weightG: extractWeight(variation),
        rawSize: variation.size ? `${variation.size.value} ${variation.size.unit}` : null,
      }))
      .sort((a, b) => (a.sizeCm || 0) - (b.sizeCm || 0) || a.price - b.price);

    const minVariation = variations.reduce((best, item) => (!best || item.price < best.price ? item : best), null);

    return {
      source: "papa",
      chain: "Papa Johns",
      name: product.name.trim(),
      normalizedName: normalizeName(product.name),
      url: product.url || null,
      description: product.short_description || product.description || "",
      minPrice: minVariation?.price ?? null,
      minSizeCm: minVariation?.sizeCm ?? null,
      variations,
      reference: {
        p23: pickPapaVariant(variations, 23, "Традиционное")?.price ?? null,
        p30: pickPapaVariant(variations, 30, "Традиционное")?.price ?? null,
        p35: pickPapaVariant(variations, 35, "Традиционное")?.price ?? null,
        p40: pickPapaVariant(variations, 40, "Традиционное")?.price ?? null,
      },
    };
  });
}

async function getDodoPizzaCards(page) {
  return page.evaluate(() => {
    const parsePrices = (text) =>
      [...String(text).replace(/[\u202f\u00a0]/g, " ").matchAll(/(\d[\d ]*)\s*₽/g)].map((match) =>
        Number(match[1].replace(/\s/g, "")),
      );

    const pizzaSection = [...document.querySelectorAll("section")].find(
      (section) => (section.querySelector("h2")?.innerText || "").trim() === "Пиццы",
    );
    if (!pizzaSection) return [];

    return [...pizzaSection.querySelectorAll("article[aria-label]")].map((card) => {
      const lines = (card.innerText || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const href = card.querySelector('a[href*="/product/"]')?.getAttribute("href");
      const prices = parsePrices(lines.join(" "));
      const flags = lines.filter((line) => /новинка|хит|выгодно|суперцена|обновили/i.test(line));
      return {
        name: (card.getAttribute("aria-label") || "").trim(),
        menuProductId: card.getAttribute("data-menu-product-id") || null,
        href: href ? new URL(href, location.origin).href : null,
        minPriceCard: prices.length ? Math.min(...prices) : null,
        flags,
      };
    });
  });
}

async function waitForDodoPizzaSection(page, timeout = 45000) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("section")].some(
        (section) => (section.querySelector("h2")?.innerText || "").trim() === "Пиццы",
      ),
    null,
    { timeout },
  );
}

async function waitForDodoMenuInteractive(page) {
  await waitForDodoPizzaSection(page);
  await page.waitForFunction(
    () => {
      const pizzaSection = [...document.querySelectorAll("section")].find(
        (section) => (section.querySelector("h2")?.innerText || "").trim() === "Пиццы",
      );
      if (!pizzaSection) return false;
      return [...pizzaSection.querySelectorAll('[data-testid="product__button"]')].some((button) =>
        /\d[\d\s\u202f\u00a0]*\s*₽/.test(button.innerText || ""),
      );
    },
    null,
    { timeout: 45000 },
  );
  await page.waitForTimeout(2500);
}

async function waitForDodoProductModal(page, productName, timeout = 25000) {
  await page.locator('[data-testid="button_add_to_cart"]').waitFor({ state: "visible", timeout });
  await page
    .waitForFunction(
      (expectedName) => {
        const modal = document.querySelector('[data-testid^="product__card-"]');
        if (!modal) return false;
        const title = (modal.innerText || "").split("\n").map((line) => line.trim()).filter(Boolean)[0] || "";
        return !expectedName || title.replace(/\s+/g, " ").trim() === expectedName;
      },
      productName,
      { timeout: 8000 },
    )
    .catch(() => {});
}

async function openDodoProduct(page, card) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(DODO_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await waitForDodoMenuInteractive(page);

      const article = card.menuProductId
        ? page.locator(`article[data-menu-product-id="${card.menuProductId}"]`).first()
        : page.locator("section").filter({ has: page.locator("h2", { hasText: "Пиццы" }) })
          .locator(`article[aria-label="${card.name.replaceAll('"', '\\"')}"]`)
          .first();

      await article.waitFor({ state: "attached", timeout: 20000 });
      await article.scrollIntoViewIfNeeded({ timeout: 20000 });
      const button = article.locator('[data-testid="product__button"]').first();
      if ((await button.count()) > 0) {
        await button.click({ timeout: 20000 });
      } else {
        await article.click({ timeout: 20000 });
      }
      await waitForDodoProductModal(page, card.name);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[dodo] open attempt ${attempt} failed for ${card.name}: ${error.message}`);
    }
  }

  throw lastError || new Error(`Dodo product did not open: ${card.name}`);
}

async function readDodoModalOptions(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('[data-testid^="product__card-"]');
    if (!modal) return { sizes: [], doughs: [] };

    const sizes = [...modal.querySelectorAll('label[data-testid^="menu__pizza_size_"]')].map((label) => ({
      text: (label.innerText || "").replace(/\s+/g, " ").trim(),
      disabled: label.getAttribute("data-disabled") === "true",
    }));

    const doughs = [...modal.querySelectorAll('input[data-testid^="base_ingredient_"]')].map((input) => {
      const label = modal.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      return {
        text: (label?.innerText || "").replace(/\s+/g, " ").trim(),
        disabled: label?.getAttribute("data-disabled") === "true",
      };
    });

    return { sizes, doughs };
  });
}

async function clickDodoOption(page, group, text) {
  await page.evaluate(
    ({ group, text }) => {
      const modal = document.querySelector('[data-testid^="product__card-"]');
      if (!modal) throw new Error("Dodo product modal not found");

      let labels;
      if (group === "size") {
        labels = [...modal.querySelectorAll('label[data-testid^="menu__pizza_size_"]')];
      } else {
        labels = [...modal.querySelectorAll('input[data-testid^="base_ingredient_"]')]
          .map((input) => modal.querySelector(`label[for="${CSS.escape(input.id)}"]`))
          .filter(Boolean);
      }

      const label = labels.find((item) => (item.innerText || "").replace(/\s+/g, " ").trim() === text);
      if (!label) throw new Error(`Dodo option not found: ${group}=${text}`);
      label.click();
    },
    { group, text },
  );
  await page
    .waitForFunction(
      ({ group, text }) => {
        const modal = document.querySelector('[data-testid^="product__card-"]');
        if (!modal) return false;
        const variantLine = (modal.innerText || "")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)[1]
          ?.toLowerCase();
        if (!variantLine) return false;
        if (group === "size") return variantLine.includes(`${Number(text.match(/\d+/)?.[0])} см`);
        return variantLine.includes(text.toLowerCase());
      },
      { group, text },
      { timeout: 5000 },
    )
    .catch(() => {});
  await page.waitForTimeout(250);
}

async function readDodoSelectedVariation(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('[data-testid^="product__card-"]');
    if (!modal) return null;
    const lines = (modal.innerText || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const buttonText = modal.querySelector('[data-testid="button_add_to_cart"]')?.innerText || "";
    return {
      title: lines[0] || "",
      variantLine: lines[1] || "",
      description: lines[2] || "",
      buttonText,
    };
  });
}

async function closeDodoModal(page) {
  const closeButton = page.locator(".popup-close-button");
  if ((await closeButton.count()) > 0) {
    await closeButton.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(180);
  }
}

async function readDodoPageState(page) {
  return page.evaluate(() => ({
    title: document.title,
    url: location.href,
    textStart: document.body?.innerText?.slice(0, 600) || "",
    sections: [...document.querySelectorAll("section")]
      .map((section) => (section.querySelector("h2")?.innerText || "").trim())
      .filter(Boolean),
  }));
}

async function loadDodoPizzaCards(page) {
  let lastState = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(DODO_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
      await waitForDodoMenuInteractive(page);
      const cards = await getDodoPizzaCards(page);
      if (cards.length) return cards;
      lastState = await readDodoPageState(page);
      console.warn(`[dodo] no pizza cards on attempt ${attempt}: ${JSON.stringify(lastState, null, 2)}`);
    } catch (error) {
      lastState = await readDodoPageState(page).catch(() => ({ error: error.message }));
      console.warn(`[dodo] menu load attempt ${attempt} failed: ${error.message}`);
    }
    await page.waitForTimeout(3000 * attempt);
  }

  throw new Error(`Dodo pizza cards not found after retries: ${JSON.stringify(lastState, null, 2)}`);
}

async function collectDodo() {
  const browser = await chromium.launch({ headless: !dodoHeaded });
  const context = await browser.newContext({
    locale: "ru-RU",
    viewport: { width: 1440, height: 1100 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  const cards = (await loadDodoPizzaCards(page)).filter((card) => !isHalfPizzaProduct(card.name));
  const selectedCards = dodoLimit > 0 ? cards.slice(0, dodoLimit) : cards;
  const products = [];

  for (const [index, card] of selectedCards.entries()) {
    const variations = [];
    console.log(`[dodo] ${index + 1}/${selectedCards.length}: ${card.name}`);

    try {
      await closeDodoModal(page);
      await openDodoProduct(page, card);

      const firstOptions = await readDodoModalOptions(page);
      const sizes = firstOptions.sizes.filter((item) => !item.disabled && item.text);
      const baseDoughs = firstOptions.doughs.filter((item) => !item.disabled && item.text);

      if (!sizes.length && !baseDoughs.length) {
        const selected = await readDodoSelectedVariation(page);
        const parsed = parseVariantLine(selected?.variantLine);
        variations.push({
          id: `${card.name}:default`,
          sizeCm: parsed.sizeCm,
          dough: parsed.dough,
          price: parseRub(selected?.buttonText) || card.minPriceCard,
          weightG: parsed.weightG,
          variantLine: selected?.variantLine || null,
        });
      }

      for (const size of sizes.length ? sizes : [{ text: null }]) {
        if (size.text) {
          await clickDodoOption(page, "size", size.text);
        }

        const freshOptions = await readDodoModalOptions(page);
        const doughs = freshOptions.doughs.filter((item) => !item.disabled && item.text);
        const doughLoop = doughs.length ? doughs : baseDoughs.length ? baseDoughs : [{ text: null }];

        for (const dough of doughLoop) {
          if (dough.text) {
            await clickDodoOption(page, "dough", dough.text);
          }

          const selected = await readDodoSelectedVariation(page);
          const parsed = parseVariantLine(selected?.variantLine);
          variations.push({
            id: `${card.name}:${size.text || parsed.sizeCm || "default"}:${dough.text || parsed.dough || "default"}`,
            sizeCm: parsed.sizeCm ?? (size.text ? Number(size.text.match(/\d+/)?.[0]) : null),
            dough: parsed.dough || dough.text || null,
            price: parseRub(selected?.buttonText) || card.minPriceCard,
            weightG: parsed.weightG,
            variantLine: selected?.variantLine || null,
          });
        }
      }
    } catch (error) {
      console.warn(`[dodo] failed ${card.name}: ${error.message}`);
    } finally {
      await closeDodoModal(page);
    }

    const unique = new Map();
    for (const variation of variations) {
      const key = `${variation.sizeCm || ""}|${variation.dough || ""}|${variation.price || ""}|${variation.weightG || ""}`;
      if (!unique.has(key)) unique.set(key, variation);
    }

    const normalized = [...unique.values()].sort(
      (a, b) => (a.sizeCm || 0) - (b.sizeCm || 0) || String(a.dough || "").localeCompare(String(b.dough || ""), "ru"),
    );

    products.push({
      source: "dodo",
      chain: "Dodo Pizza",
      name: card.name,
      normalizedName: normalizeName(card.name),
      url: card.href,
      flags: card.flags,
      minPriceCard: card.minPriceCard,
      minPrice: normalized.reduce((best, item) => (!best || item.price < best.price ? item : best), null)?.price || card.minPriceCard,
      variations: normalized,
    });
  }

  await browser.close();
  return products;
}

const manualMatches = [
  ["Пепперони", "Пепперони", "Пепперони", "exact"],
  ["Сырная", "Сырная", "Сырная", "exact"],
  ["Ветчина и грибы", "Ветчина и грибы", "Ветчина и грибы", "exact"],
  ["Мясная", "Мясная", "Мясная", "exact"],
  ["Маргарита", "Маргарита", "Маргарита", "exact"],
  ["Гавайская", "Гавайская", "Гавайская", "exact"],
  ["Карбонара", "Любимая Карбонара", "Карбонара", "review"],
  ["Цыпленок барбекю", "Цыпленок Барбекю", "Цыпленок барбекю", "exact"],
  ["Цыпленок ранч", "Цыпленок Рэнч", "Цыпленок ранч", "review"],
];

function buildMatches(papa, dodo) {
  const papaByName = new Map(papa.map((item) => [item.normalizedName, item]));
  const dodoByName = new Map(dodo.map((item) => [item.normalizedName, item]));

  return manualMatches
    .map(([label, papaName, dodoName, status]) => {
      const papaProduct = papaByName.get(normalizeName(papaName));
      const dodoProduct = dodoByName.get(normalizeName(dodoName));
      if (!papaProduct || !dodoProduct) return null;

      return {
        label,
        status,
        papaName,
        dodoName,
        papaProductId: papaProduct.normalizedName,
        dodoProductId: dodoProduct.normalizedName,
      };
    })
    .filter(Boolean);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(OUT_FILE, "utf8"));
  } catch {
    existing = null;
  }

  const papa = source === "dodo" ? existing?.papa?.products || [] : await collectPapa();
  const dodo = source === "papa" ? existing?.dodo?.products || [] : await collectDodo();
  const matches = buildMatches(papa, dodo);

  const snapshot = {
    meta: {
      city: "Москва",
      collectedAt: new Date().toISOString(),
      urls: {
        papa: PAPA_URL,
        dodo: DODO_URL,
      },
      source,
      notes: [
        "Papa Johns is collected from window.__PRELOADED_STATE__.",
        "Dodo Pizza is collected with Playwright browser rendering and product configurator clicks.",
        "Only standard-crust/base pizza variations are included.",
        "Half-and-half pizzas are excluded from the current analytics scope.",
      ],
    },
    papa: {
      products: papa,
    },
    dodo: {
      products: dodo,
    },
    matches,
  };

  await fs.writeFile(OUT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await fs.writeFile(
    OUT_JS_FILE,
    `window.PIZZA_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};\n`,
    "utf8",
  );
  console.log(`[done] wrote ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`[done] wrote ${path.relative(ROOT, OUT_JS_FILE)}`);
  console.log(`[done] papa=${papa.length}, dodo=${dodo.length}, matches=${matches.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
