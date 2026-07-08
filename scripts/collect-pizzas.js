const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(OUT_DIR, "pizza-snapshot.json");
const OUT_JS_FILE = path.join(OUT_DIR, "pizza-snapshot.js");
const OUT_DODO_RESTAURANTS_FILE = path.join(OUT_DIR, "dodo-restaurants-moscow.json");
const OUT_DODO_RESTAURANTS_JS_FILE = path.join(OUT_DIR, "dodo-restaurants-moscow.js");

const PAPA_DEFAULT_URL = "https://papajohns.ru/moscow";
const DODO_DEFAULT_URL = "https://dodopizza.ru/moscow/veshnyaki";
const DODO_CONTACTS_DEFAULT_URL = "https://dodopizza.ru/moscow/contacts";
const DODO_COUNTRY_ID = 643;

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const clean = arg.replace(/^--/, "");
    const eqIndex = clean.indexOf("=");
    return eqIndex >= 0 ? [clean.slice(0, eqIndex), clean.slice(eqIndex + 1)] : [clean, "true"];
  }),
);

const source = args.get("source") || "all";
const dodoLimit = Number(args.get("dodo-limit") || 0);
const dodoRestaurantLimit = Number(args.get("dodo-restaurant-limit") || 0);
const dodoRestaurantStart = Number(args.get("dodo-restaurant-start") || 0);
const dodoAllRestaurants = args.get("dodo-all-restaurants") === "true" || process.env.DODO_ALL_RESTAURANTS === "true";
const dodoRestaurantsOnly = args.get("dodo-restaurants-only") === "true";
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
const DODO_CONTACTS_URL = args.get("dodo-contacts-url") || process.env.DODO_CONTACTS_URL || DODO_CONTACTS_DEFAULT_URL;

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

function normalizeDodoDisplayName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isStandardPapaCrust(variation) {
  return (variation.stuffed_crust || variation.crust || "none") === "none";
}

function isHalfPizzaProduct(name) {
  return /половин/i.test(normalizeName(name));
}

function isCustomPizzaProduct(name) {
  const normalized = normalizeName(name);
  return normalized === "создай свою пиццу" || normalized === "соберите свою пиццу";
}

function shouldSkipPizzaProduct(name) {
  return isHalfPizzaProduct(name) || isCustomPizzaProduct(name);
}

function filterIncludedPizzaProducts(products) {
  return (products || []).filter((product) => !shouldSkipPizzaProduct(product.name));
}

function filterDodoResult(result = {}) {
  return {
    products: filterIncludedPizzaProducts(result.products),
    restaurants: result.restaurants || [],
    restaurantProducts: (result.restaurantProducts || []).map((entry) => ({
      ...entry,
      products: filterIncludedPizzaProducts(entry.products),
    })),
  };
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
    (item) => item.category === "pizza" && !shouldSkipPizzaProduct(item.name),
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

function formatDodoAddress(address) {
  if (!address?.street) return "";
  const street = address.street.shortStreetTypeName
    ? `${address.street.shortStreetTypeName} ${address.street.name}`
    : address.street.name;
  return [street, address.houseNumber].filter(Boolean).join(", ");
}

function dodoAbsoluteUrl(value) {
  return new URL(value, "https://dodopizza.ru").toString().replace(/\/$/, "");
}

function normalizeDodoRestaurant(raw) {
  const slug = raw.translitAlias || raw.menuRoute?.url?.split("/").filter(Boolean).pop() || raw.id;
  return {
    id: raw.id,
    uuid: raw.uuid || null,
    slug,
    alias: raw.alias || raw.name || slug,
    name: raw.name || raw.alias || slug,
    address: formatDodoAddress(raw.address),
    menuUrl: dodoAbsoluteUrl(raw.menuRoute?.url || `/moscow/${slug}`),
    contactsUrl: dodoAbsoluteUrl(`/moscow/contacts/${slug}`),
    rawContactsUrl: dodoAbsoluteUrl(raw.contactsRoute?.url || `/moscow/${slug}/contacts`),
    metroStations: raw.metroStations || [],
    coordinates: raw.coordinates || null,
    isClosed: Boolean(raw.isClosed),
    takesCarryoutOrders: Boolean(raw.takesCarryoutOrders),
    timeZoneUtcOffset: raw.timeZoneUtcOffset || null,
  };
}

function buildDodoRestaurantFromUrl(menuUrl) {
  const slug = menuUrl.split("/").filter(Boolean).pop();
  return {
    id: null,
    uuid: null,
    slug,
    alias: slug,
    name: slug,
    address: "",
    menuUrl,
    contactsUrl: "",
    rawContactsUrl: "",
    metroStations: [],
    coordinates: null,
    isClosed: false,
    takesCarryoutOrders: true,
    timeZoneUtcOffset: null,
  };
}

async function collectDodoRestaurants(page) {
  await page.goto(DODO_CONTACTS_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => Array.isArray(window.initialState?.pizzerias), null, { timeout: 60000 });
  const restaurants = await page.evaluate(() => window.initialState.pizzerias);
  return restaurants.map(normalizeDodoRestaurant).sort((a, b) => a.alias.localeCompare(b.alias, "ru"));
}

async function writeDodoRestaurants(restaurants) {
  await fs.writeFile(OUT_DODO_RESTAURANTS_FILE, `${JSON.stringify(restaurants, null, 2)}\n`, "utf8");
  await fs.writeFile(
    OUT_DODO_RESTAURANTS_JS_FILE,
    `window.DODO_MOSCOW_RESTAURANTS = ${JSON.stringify(restaurants, null, 2)};\n`,
    "utf8",
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

async function openDodoProductFromCurrentMenu(page, card) {
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
}

async function openDodoProduct(page, card, menuUrl = DODO_URL) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(menuUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await waitForDodoMenuInteractive(page);
      await openDodoProductFromCurrentMenu(page, card);
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

async function loadDodoPizzaCards(page, menuUrl = DODO_URL) {
  let lastState = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(menuUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
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

function dodoMenuApiUrlFromRestaurant(restaurant) {
  const uuid = String(restaurant.uuid || "").replace(/-/g, "").toLowerCase();
  return uuid
    ? `https://dodopizza.ru/api/v5/menu/delivery/countries/${DODO_COUNTRY_ID}/pizzerias/${uuid}?cultures=ru-RU&subcategoriesInMenu=false`
    : null;
}

function resolveDodoApiRef(apiData, ref) {
  const match = String(ref?.$ref || "").match(/#\/items\/(\d+)/);
  return match ? apiData.items[Number(match[1])] || null : null;
}

function getDodoApiPizzaItems(apiData) {
  const pizzaCategory = (apiData.structure || []).find((category) => normalizeName(category.title) === "пиццы");
  if (!pizzaCategory) return [];
  return (pizzaCategory.items || [])
    .map((row) => resolveDodoApiRef(apiData, row.menuItem))
    .filter(Boolean);
}

function parseDodoApiDough(product) {
  const basis = (product.ingredientGroups || []).find((group) => group.isBasis);
  const text = basis?.name || "";
  if (/тонк/i.test(text)) return "Тонкое";
  if (/традиц/i.test(text)) return "Традиционное";
  return text || null;
}

function parseDodoApiSize(value) {
  const match = String(value || "").match(/(\d+)\s*см/i);
  return match ? Number(match[1]) : null;
}

function parseDodoApiProduct(apiProduct, restaurant) {
  const name = normalizeDodoDisplayName(apiProduct.name);
  const variations = (apiProduct.variations || [])
    .map((variation) => variation.product)
    .filter((product) => product && Number.isFinite(product.price) && product.price > 50)
    .map((product) => {
      const sizeCm = parseDodoApiSize(product.size);
      const dough = parseDodoApiDough(product);
      const weightG = Number(product.foodValue?.weight) || null;
      return {
        id: product.id || `${name}:${sizeCm || "default"}:${dough || "default"}`,
        sizeCm,
        dough,
        price: product.price,
        weightG,
        variantLine: [sizeCm ? `${sizeCm} см` : null, dough ? `${dough.toLowerCase()} тесто` : null, weightG ? `${weightG} г` : null]
          .filter(Boolean)
          .join(", ") || null,
      };
    });

  const unique = new Map();
  for (const variation of variations) {
    const key = `${variation.sizeCm || ""}|${variation.dough || ""}|${variation.price || ""}|${variation.weightG || ""}`;
    if (!unique.has(key)) unique.set(key, variation);
  }

  const normalized = [...unique.values()].sort(
    (a, b) => (a.sizeCm || 0) - (b.sizeCm || 0) || String(a.dough || "").localeCompare(String(b.dough || ""), "ru"),
  );
  const minPrice = normalized.reduce((best, item) => (!best || item.price < best.price ? item : best), null)?.price || null;

  return {
    source: "dodo",
    chain: "Dodo Pizza",
    name,
    normalizedName: normalizeName(name),
    url: restaurant.menuUrl,
    restaurant: {
      id: restaurant.id,
      slug: restaurant.slug,
      alias: restaurant.alias,
      address: restaurant.address,
      menuUrl: restaurant.menuUrl,
    },
    flags: [],
    minPriceCard: minPrice,
    minPrice,
    variations: normalized,
  };
}

async function collectDodoRestaurantFromApi(page, restaurant, productLimit = dodoLimit) {
  const apiUrl = dodoMenuApiUrlFromRestaurant(restaurant);
  if (!apiUrl) throw new Error(`Dodo API URL cannot be built without restaurant uuid: ${restaurant.slug}`);

  const apiData = await loadDodoApiData(page, restaurant, apiUrl);
  const apiProducts = getDodoApiPizzaItems(apiData).filter((product) => !shouldSkipPizzaProduct(product.name));
  const selectedProducts = productLimit > 0 ? apiProducts.slice(0, productLimit) : apiProducts;
  const products = selectedProducts.map((product) => parseDodoApiProduct(product, restaurant));
  console.log(`[dodo:${restaurant.slug}] api products=${products.length}, variations=${products.reduce((sum, product) => sum + product.variations.length, 0)}`);
  return products;
}

async function fetchDodoApiFromPage(page, apiUrl) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      credentials: "include",
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Dodo API HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  }, apiUrl);
}

async function loadDodoApiData(page, restaurant, apiUrl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await fetchDodoApiFromPage(page, apiUrl);
    } catch (error) {
      lastError = error;
      console.warn(`[dodo:${restaurant.slug}] api fetch attempt ${attempt} failed: ${error.message}`);
      await page.waitForTimeout(1200 * attempt);
    }
  }

  try {
    const responseBase = apiUrl.split("?")[0];
    const [response] = await Promise.all([
      page.waitForResponse(
        (item) => item.url().startsWith(responseBase) && item.status() === 200,
        { timeout: 60000 },
      ),
      page.goto(restaurant.menuUrl, { waitUntil: "domcontentloaded", timeout: 60000 }),
    ]);
    return await response.json();
  } catch (error) {
    throw lastError || error;
  }
}

async function collectDodoRestaurantFromUi(page, restaurant, productLimit = dodoLimit) {
  const cards = (await loadDodoPizzaCards(page, restaurant.menuUrl)).filter((card) => !shouldSkipPizzaProduct(card.name));
  const selectedCards = productLimit > 0 ? cards.slice(0, productLimit) : cards;
  const products = [];

  for (const [index, card] of selectedCards.entries()) {
    const variations = [];
    console.log(`[dodo:${restaurant.slug}] ${index + 1}/${selectedCards.length}: ${card.name}`);

    try {
      await closeDodoModal(page);
      try {
        await openDodoProductFromCurrentMenu(page, card);
      } catch (error) {
        console.warn(`[dodo:${restaurant.slug}] current menu open failed for ${card.name}: ${error.message}`);
        await openDodoProduct(page, card, restaurant.menuUrl);
      }

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
      console.warn(`[dodo:${restaurant.slug}] failed ${card.name}: ${error.message}`);
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
      restaurant: {
        id: restaurant.id,
        slug: restaurant.slug,
        alias: restaurant.alias,
        address: restaurant.address,
        menuUrl: restaurant.menuUrl,
      },
      flags: card.flags,
      minPriceCard: card.minPriceCard,
      minPrice: normalized.reduce((best, item) => (!best || item.price < best.price ? item : best), null)?.price || card.minPriceCard,
      variations: normalized,
    });
  }

  return products;
}

async function collectDodoRestaurant(page, restaurant, productLimit = dodoLimit) {
  try {
    return await collectDodoRestaurantFromApi(page, restaurant, productLimit);
  } catch (error) {
    console.warn(`[dodo:${restaurant.slug}] api collection failed, falling back to UI: ${error.message}`);
    return collectDodoRestaurantFromUi(page, restaurant, productLimit);
  }
}

function averageNumber(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function priceStats(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return { avg: null, min: null, max: null, count: 0 };
  return {
    avg: Math.round(averageNumber(usable)),
    min: Math.min(...usable),
    max: Math.max(...usable),
    count: usable.length,
  };
}

function aggregateDodoCityProducts(restaurantProducts) {
  const byProduct = new Map();
  for (const entry of restaurantProducts) {
    for (const product of entry.products) {
      const key = product.normalizedName;
      if (!byProduct.has(key)) byProduct.set(key, []);
      byProduct.get(key).push({ restaurant: entry.restaurant, product });
    }
  }

  return [...byProduct.values()]
    .map((items) => {
      const first = items[0].product;
      const variationGroups = new Map();

      for (const item of items) {
        for (const variation of item.product.variations || []) {
          const key = `${variation.sizeCm || ""}|${variation.dough || ""}`;
          if (!variationGroups.has(key)) variationGroups.set(key, []);
          variationGroups.get(key).push({ restaurant: item.restaurant, variation });
        }
      }

      const variations = [...variationGroups.entries()]
        .map(([key, rows]) => {
          const [sizeRaw, dough] = key.split("|");
          const prices = rows.map((row) => row.variation.price);
          const weights = rows.map((row) => row.variation.weightG);
          const stats = priceStats(prices);
          return {
            id: `${first.name}:${sizeRaw || "default"}:${dough || "default"}:moscow-average`,
            sizeCm: sizeRaw ? Number(sizeRaw) : null,
            dough: dough || null,
            price: stats.avg,
            avgPrice: stats.avg,
            minPrice: stats.min,
            maxPrice: stats.max,
            restaurantCount: new Set(rows.map((row) => row.restaurant.slug)).size,
            sampleCount: stats.count,
            weightG: Math.round(averageNumber(weights) || 0) || null,
            variantLine: rows[0]?.variation.variantLine || null,
          };
        })
        .sort((a, b) => (a.sizeCm || 0) - (b.sizeCm || 0) || String(a.dough || "").localeCompare(String(b.dough || ""), "ru"));

      const minStats = priceStats(items.map((item) => item.product.minPrice));
      const cardMinStats = priceStats(items.map((item) => item.product.minPriceCard));

      return {
        source: "dodo",
        chain: "Dodo Pizza",
        cityAverage: true,
        name: first.name,
        normalizedName: first.normalizedName,
        url: first.url,
        flags: [...new Set(items.flatMap((item) => item.product.flags || []))],
        minPriceCard: cardMinStats.avg,
        minPrice: minStats.avg,
        priceStats: {
          minPrice: minStats,
          minPriceCard: cardMinStats,
        },
        restaurantCount: new Set(items.map((item) => item.restaurant.slug)).size,
        restaurantsWithProduct: [...new Set(items.map((item) => item.restaurant.slug))].sort(),
        variations,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
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

  let restaurants = [];
  let restaurantProducts = [];
  let products = [];

  if (dodoAllRestaurants) {
    restaurants = await collectDodoRestaurants(page);
    await writeDodoRestaurants(restaurants);
    const selectedRestaurants = restaurants.slice(dodoRestaurantStart, dodoRestaurantLimit > 0 ? dodoRestaurantStart + dodoRestaurantLimit : undefined);
    console.log(`[dodo] restaurants=${restaurants.length}, selected=${selectedRestaurants.length}, start=${dodoRestaurantStart}`);

    for (const [index, restaurant] of selectedRestaurants.entries()) {
      console.log(`[dodo] restaurant ${index + 1}/${selectedRestaurants.length}: ${restaurant.alias} (${restaurant.slug})`);
      const entry = {
        restaurant,
        products: await collectDodoRestaurant(page, restaurant),
      };
      restaurantProducts.push(entry);
    }

    products = aggregateDodoCityProducts(restaurantProducts);
  } else {
    let restaurant = buildDodoRestaurantFromUrl(DODO_URL);
    try {
      const knownRestaurants = await collectDodoRestaurants(page);
      restaurant = knownRestaurants.find((item) => item.menuUrl === DODO_URL || item.slug === restaurant.slug) || restaurant;
    } catch (error) {
      console.warn(`[dodo] restaurant lookup failed, falling back to URL-only mode: ${error.message}`);
    }
    products = await collectDodoRestaurant(page, restaurant);
  }

  await browser.close();
  return { products, restaurants, restaurantProducts };
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

  if (dodoRestaurantsOnly) {
    const browser = await chromium.launch({ headless: !dodoHeaded });
    const context = await browser.newContext({
      locale: "ru-RU",
      viewport: { width: 1440, height: 1100 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    const restaurants = await collectDodoRestaurants(page);
    await writeDodoRestaurants(restaurants);
    await browser.close();
    console.log(`[done] wrote ${path.relative(ROOT, OUT_DODO_RESTAURANTS_FILE)}`);
    console.log(`[done] wrote ${path.relative(ROOT, OUT_DODO_RESTAURANTS_JS_FILE)}`);
    console.log(`[done] dodo restaurants=${restaurants.length}`);
    return;
  }

  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(OUT_FILE, "utf8"));
  } catch {
    existing = null;
  }

  const papa = source === "dodo" ? filterIncludedPizzaProducts(existing?.papa?.products) : await collectPapa();
  const dodoResult = source === "papa"
    ? filterDodoResult({
      products: existing?.dodo?.products || [],
      restaurants: existing?.dodo?.restaurants || [],
      restaurantProducts: existing?.dodo?.restaurantProducts || [],
    })
    : filterDodoResult(await collectDodo());
  const dodo = dodoResult.products;
  const matches = buildMatches(papa, dodo);

  const snapshot = {
    meta: {
      city: "Москва",
      collectedAt: new Date().toISOString(),
      urls: {
        papa: PAPA_URL,
        dodo: DODO_URL,
        dodoContacts: DODO_CONTACTS_URL,
      },
      source,
      dodoAllRestaurants,
      notes: [
        "Papa Johns is collected from window.__PRELOADED_STATE__.",
        "Dodo Pizza is collected with Playwright browser rendering and api/v5 menu JSON; configurator clicks are kept as fallback.",
        "Only standard-crust/base pizza variations are included.",
        "Half-and-half pizzas are excluded from the current analytics scope.",
        "Custom constructor pizzas are excluded from price analytics.",
        "When dodoAllRestaurants=true, Dodo products are city-average aggregates and restaurantProducts keeps per-restaurant prices.",
      ],
    },
    papa: {
      products: papa,
    },
    dodo: {
      products: dodo,
      restaurants: dodoResult.restaurants || [],
      restaurantProducts: dodoResult.restaurantProducts || [],
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
  if (dodoResult.restaurants?.length) {
    console.log(`[done] wrote ${path.relative(ROOT, OUT_DODO_RESTAURANTS_FILE)}`);
    console.log(`[done] dodo restaurants=${dodoResult.restaurants.length}, restaurant snapshots=${dodoResult.restaurantProducts.length}`);
  }
  console.log(`[done] papa=${papa.length}, dodo=${dodo.length}, matches=${matches.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
