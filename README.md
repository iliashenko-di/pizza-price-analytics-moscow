# Аналитика цен пицц

Статический дашборд и Playwright-сборщик для сравнения пицц Papa Johns и Dodo Pizza в Москве.

## Что внутри

- `index.html` - интерактивный GitHub Pages дашборд без сборки и backend-сервера.
- `scripts/collect-pizzas.js` - реальный сборщик меню пицц.
- `data/papa-segments.js` - фиксированный справочник сегментов Papa Johns из файла `Сегменты МСК.xlsx`.
- `data/pizza-snapshot.json` - JSON-срез данных для анализа.
- `data/pizza-snapshot.js` - тот же срез в виде `window.PIZZA_SNAPSHOT` для открытия `index.html` напрямую из файла.
- `data/dodo-restaurants-moscow.json` - найденные московские рестораны Dodo Pizza из страницы контактов.
- `data/dodo-restaurants-moscow.js` - тот же список ресторанов в виде `window.DODO_MOSCOW_RESTAURANTS`.
- `REPORT.md` - отчет по источникам, парсерам, качеству данных и дальнейшему внедрению.

Срез данных: 8 июля 2026, город Москва.

Источники меню:

- https://papajohns.ru/moscow
- https://dodopizza.ru/moscow/veshnyaki
- https://dodopizza.ru/moscow/contacts

## Фокус текущей версии

Рассматриваются только пиццы.

Не рассматриваются:

- комбо;
- закуски;
- напитки;
- десерты;
- соусы;
- римские пиццы Dodo;
- пиццы из половинок;
- конструкторы "Создай свою пиццу" и "Соберите свою пиццу";
- модифицированные бортики и другие нестандартные края;
- товары для детей, если они не входят в основной раздел пицц.

## Установка

```bash
npm install
npx playwright install chromium
```

Playwright уже добавлен в `package.json`. Chromium нужен для сбора Dodo Pizza, потому что сайт отдает меню через браузерный сценарий.

## Сбор данных

Полный сбор Papa Johns + Dodo Pizza:

```bash
npm run collect
```

С конкретными источниками:

```bash
npm run collect -- --papa-url=https://papajohns.ru/moscow --dodo-url=https://dodopizza.ru/moscow/veshnyaki
```

Только Papa Johns:

```bash
npm run collect:papa
```

Только Dodo Pizza:

```bash
npm run collect:dodo
```

Только список московских ресторанов Dodo Pizza:

```bash
npm run collect:dodo:restaurants
```

Полный сбор Dodo Pizza по всем московским ресторанам:

```bash
npm run collect:dodo:moscow
```

В этом режиме `data/pizza-snapshot.json` хранит средние Dodo-цены по Москве в `dodo.products`, а исходные цены каждого ресторана - в `dodo.restaurantProducts`. Список найденных ресторанов дополнительно записывается в `data/dodo-restaurants-moscow.json` и `data/dodo-restaurants-moscow.js`.

Быстрый тест городского режима на одном ресторане и двух товарах:

```bash
npm run collect:dodo:moscow:test
```

Только Dodo Pizza, явно для пиццерии Вешняки:

```bash
npm run collect:dodo:veshnyaki
```

Для другой Dodo-точки можно передать URL меню или товара. Product URL будет автоматически приведен к URL меню:

```bash
npm run collect -- --dodo-url=https://dodopizza.ru/moscow/veshnyaki/product/myasnaya-pizza
```

Для быстрой отладки Dodo можно ограничить число карточек:

```bash
npm run collect -- --source=dodo --dodo-limit=5
```

Результат записывается в:

- `data/pizza-snapshot.json`
- `data/pizza-snapshot.js`
- `data/dodo-restaurants-moscow.json` и `data/dodo-restaurants-moscow.js`, если запускался сбор списка или городской режим Dodo.

## Запуск через страницу

На дашборде есть блок "Новый сбор данных". Он позволяет выбрать город Papa Johns и город + ресторан Dodo Pizza. Правила сбора пока не настраиваются и всегда одинаковые:

- только пиццы;
- только стандартный борт;
- без половинок;
- базовые цены.

Страница формирует команду GitHub CLI и ссылку на GitHub Action. Сам Playwright-сбор выполняется не в браузере, а в GitHub Actions workflow `Collect pizza prices`, потому что статическая GitHub Pages страница не может безопасно запускать Chromium и коммитить обновленный snapshot.

В GitHub Action есть переключатель `dodo_all_restaurants`. Если он равен `false`, собирается выбранный ресторан Dodo. Если `true`, сборщик сначала получает все московские рестораны со страницы контактов, затем проходит по их меню и считает городские средние цены.

После запуска workflow:

1. устанавливает зависимости и Chromium;
2. запускает `scripts/collect-pizzas.js` с выбранными URL;
3. проверяет качество snapshot;
4. коммитит `data/pizza-snapshot.json` и `data/pizza-snapshot.js`;
5. GitHub Pages публикует обновленный дашборд.

## Как открыть дашборд

Можно открыть `index.html` напрямую в браузере. Для локальной проверки через HTTP:

```bash
npm run serve
```

Затем открыть:

```text
http://127.0.0.1:8765/index.html
```

## Как развернуть на GitHub Pages

1. Создать GitHub-репозиторий.
2. Загрузить файлы проекта в корень репозитория.
3. Включить `Settings -> Pages -> Deploy from a branch`.
4. Выбрать ветку `main` и папку `/root`.

Дашборд не требует домена, сервера или backend API. Для регулярного обновления цен можно добавить расписание к уже созданному GitHub Action, который запускает `npm run collect` и коммитит обновленный `data/pizza-snapshot.json`.

## Текущий результат сбора

- Papa Johns: 44 пиццы, 289 вариаций со стандартным бортом, без конструктора "Создай свою пиццу".
- Dodo Pizza Москва: 142 ресторана найдены на странице контактов и сохранены в `data/dodo-restaurants-moscow.json`.
- Dodo Pizza в текущем snapshot: 39 агрегированных пицц, 265 агрегированных вариаций со средними ценами по Москве.
- Dodo Pizza по ресторанам: 5 109 ресторанных карточек пицц и 34 399 ресторанных вариаций в `dodo.restaurantProducts`.
- Papa-сегменты: 8 сегментов, 61 позиция из Excel.
- Papa в текущем snapshot покрыт сегментами: 44 из 44 позиций.
- Dodo распределено по сегментам: 39 из 39 позиций.
- Сегментных строк, где Dodo выше Papa: 8.
- Сегментных строк, где Dodo ниже Papa: 14.
- Dodo-позиции без снятых вариаций: нет.

## Что показывает дашборд

- KPI по Papa-сегментам, покрытию текущего меню, распределению Dodo и индексу к Papa.
- Фиксированную ценовую лестницу Papa Johns по сегментам и размерам 23/30/35/40.
- Автоматическое распределение Dodo Pizza по ближайшему Papa-сегменту на основе цен.
- Сравнение по сегментам: средняя цена Dodo внутри сегмента против базовой цены Papa.
- Цветовую логику от Papa: зеленый процент - Dodo выше Papa, красный процент - Dodo ниже Papa.
- Ручную проверку любой Dodo-пиццы: присвоенный сегмент, уровень уверенности, все размеры и разрыв к Papa.
- Позиции Papa вне сегментного справочника и Dodo-позиции с низкой уверенностью сегмента.
- CSV-выгрузку сегментного сравнения.

Размеры Dodo сопоставляются с Papa так:

- Dodo 25 см -> Papa 23 см;
- Dodo 30 см -> Papa 30 см;
- Dodo 35 см -> Papa 35 см;
- Dodo 20 см показывается отдельно и не влияет на выбор сегмента.

## Выбор парсера

Выбран Playwright.

Почему:

- Papa Johns можно собирать обычным HTTP-запросом из `window.__PRELOADED_STATE__`.
- Dodo Pizza требует браузерного рендера и конкретного ресторанного URL: цены меняются между `/moscow` и, например, `/moscow/veshnyaki`.
- Playwright нужен для прохождения браузерного сценария Dodo и получения API-данных меню. Основной сбор Dodo идет через JSON `api/v5/menu/delivery/.../pizzerias/{uuid}`, а клики по конфигуратору оставлены как fallback.

Когда добавить Crawlee:

- появятся несколько конкурентов;
- понадобится очередь URL;
- нужен перезапуск упавших задач;
- понадобится централизованное хранение результатов и retry/session policy.

Почему не Scrapegraph AI на первом этапе:

- для цен нужны детерминированные факты, а не LLM-извлечение;
- пакет тянет большую LangChain/LLM-экосистему;
- сложнее объяснять и воспроизводить каждую цену.

## Роль нейросети

Сбор цен, размеров, теста и веса выполняется без нейросети: Papa Johns разбирается из состояния страницы, Dodo Pizza собирается через Playwright и JSON API меню. OpenAI API можно подключать позже для подсказок по сопоставлению похожих пицц и текстовых выводов, но не как источник цен.
