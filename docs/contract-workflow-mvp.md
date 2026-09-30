# Contract harness: повний план MVP для LLM-розробника

Оновлено: 2026-09-30. Редакція: MDX як джерело дизайну. Статус: специфікація майбутньої реалізації, не документація готового пакета.

Цей документ замінює попередню пропозицію workflows. Поточний фокус — ядро харнесу, CLI та модульний `design.mdx` із бізнес-описом і TS-контрактами. `design.generated.ts` автоматично виділяється з MDX та не редагується вручну. Skills, інтеграція з редактором і автоматичний виклик LLM до MVP не входять. Назва CLI `design` — робоча; доступність відповідної назви npm-пакета не перевірялась.


Ця редакція замінює схему з окремими `design.ts` і `business.md`. Вісім директив та розподіл відповідальності харнес / LLM / test environment збережені. Додано `ts design`, команди extraction і зіставлення діагностик із MDX. Сам план залишається Markdown-документом для LLM-розробника.

## 1. Завдання для агента

Побудуй локальний TypeScript CLI, який читає MDX, виділяє позначені TS-контракти з коментарями, знаходить позначені реалізації та тестові декларації, перевіряє структурну узгодженість і формує контекст для LLM-рев’ю. Джерело дизайну — авторські `design.mdx`; реалізації та тести читаються з їхніх звичайних файлів. Похідний TS не стає незалежним джерелом вимог. База даних, сервер і зовнішні API не потрібні.

Працюй за етапами з розділу 14. Спочатку прочитай інструкції репозиторію й наявну структуру. Повторно використовуй придатні компоненти. Вибирай найпростішу реалізацію, яка задовольняє acceptance matrix. Не додавай можливості з розділу «Поза MVP» без окремої задачі.

Не змінюй вимоги чи не видаляй негативні fixtures, щоб отримати успішну перевірку. Якщо виявиш суперечність специфікації, опиши конкретні два правила та запропонуй мінімальне уточнення. Рутинні технічні рішення приймай сам і коротко фіксуй у README.

**Продуктовий результат:** агент і людина можуть за одним контрактом побачити його призначення, сигнатури, поведінкові зобов’язання, реалізації, прив’язані тести та задекларовані залежності.

**Результат `check` не означає, що програма працює правильно.** Він означає лише, що перелічені у звіті перевірки не знайшли структурних порушень у заданій області.

## 2. Погоджені рішення та припущення MVP

### Погоджені рішення

- `.design` розташована всередині модуля; один авторський `design.mdx` містить опис, контракти та приклади.
- Лише fenced-блоки `ts design` утворюють контрактний TS-модуль. Звичайні `ts`-блоки — приклади.
- `design.generated.ts` — автоматичний похідний файл для TypeScript/IDE. Його не редагують вручну.
- Виконуваний код і тести залишаються у звичайних файлах проєкту.
- Теги короткі, без префікса: `@contract`, `@data`, `@description`, `@uses`, `@implements`, `@invariant`, `@tests`, `@covers`.
- Реалізація зв’язується з контрактом коментарем `@implements`; нативний TypeScript `implements` не потрібен і не генерується харнесом.
- Інваріанти можуть бути на рівні контракту та окремих методів. У кожного є короткий ID і текст; інваріантів може бути багато.
- Усі ID інваріантів у межах одного контракту унікальні, незалежно від методу.
- Один інваріант може мати кілька тестів; один тест — кілька інваріантів.
- Харнес перевіряє наявність тестових декларацій і коректність прив’язок. LLM окремо оцінює зміст тестів. Test environment виконує тести.
- У тегах немає namespaces і довгих адрес. Контексти задають ім’я контракту та `@tests`.
- Дизайни можуть використовувати публічні типи та контракти інших дизайнів.

### Припущення, зафіксовані для першої версії

Це свідомі обмеження обсягу, а не твердження, що інших варіантів бути не може.

| Питання | Рішення MVP |
| --- | --- |
| Формат дизайну | `.design/design.mdx`; звичайний `.md` як альтернативний вхід відкладено |
| Мова цільового коду | TypeScript у `ts design` та реалізаціях/тестах `.ts`; без JS/TSX |
| Extraction | Фіксований output `.design/design.generated.ts` поруч із MDX; без довільних output paths |
| Git для generated TS | Для MVP комітити похідні файли; CI перевіряє їхню актуальність. Це обрана конвенція, не вимога MDX |
| Відображення MDX | Parsing без виконання; JSX rendering, React runtime та docs site поза MVP |
| Runtime CLI | Node.js 24 LTS; звичайна компіляція CLI у JavaScript |
| Компілятор | Пакет `typescript` із Compiler API; зафіксувати перевірену версію в lockfile |
| Адаптер декларацій тестів | Один: `node:test`; Jest/Vitest — пізніше |
| Compiler context | Один `tsconfig` на виклик; кілька конфігурацій запускаються окремо |
| Імена контрактів | Глобально унікальні у налаштованому discovery scope |
| Форма контракту | Exported named interface: об’єкт із methods або один call signature |
| Реалізації | Exported named class/function/const; один `@implements` на декларацію |
| Складні контракти | Generics, inheritance/merging, overloads, constructor signatures — поза MVP |
| Lock-рівні | `@final`, `@extendable`, `@open`, baseline та API diff — поза MVP |
| Цикли дизайнів | Міжмодульні цикли — помилка політики MVP; це не обмеження TypeScript |
| Контракт без інваріантів | Дозволений, але має warning; типова відповідність перевіряється |
| Метод без `@description` | Дозволений. Опис контракту та `@data` обов’язковий |
| Немає бізнес-прози у MDX | Контракти дозволені, але `W_BUSINESS_CONTEXT_MISSING`; review отримує наявний документ |
| Наявність реалізації | Implementation-фаза вимагає щонайменше одну позначену реалізацію кожного контракту |
| LLM-рев’ю | CLI експортує матеріали й інструкцію; користувач або coding-агент передає їх LLM |

Якщо зовнішній порт реалізовано сторонньою бібліотекою, локальний адаптер із `@implements` представляє його в scope. Не додавати фіктивну реалізацію лише для проходження перевірки. Не підключені модулі перевіряються окремим discovery scope або лише design-фазою.

## 3. Розподіл відповідальності

| Компонент | Відповідальність | Чого не стверджує |
| --- | --- | --- |
| Харнес | Metadata, references, TS-сумісність, наявність test declarations, граф дизайну | Що тест запускався, пройшов, достатній або перевіряє потрібну поведінку |
| LLM-рев’ю | Оцінка зв’язку бізнес-опису, інваріантів, реалізації, сценаріїв і assertions | Детермінований доказ або гарантія відсутності помилок |
| Test environment | Виконання, pass/fail, skip/todo, retries, flaky, runtime coverage | Автоматичне розуміння бізнес-сенсу вимоги |

Харнес не запускає тести, не імпортує тестові звіти, не зберігає їхній стан і не має власних run ID, commit SHA чи історії виконання. Він не змінює політику CI щодо пропущених або нестабільних тестів.

`it.skip`, `it.todo`, порожній callback або `assert.ok(true)` можуть задовольнити перевірку існування декларації. Це принципова межа продукту. Харнес не створює strict-режим, який оцінює ці випадки як якість або виконання тесту.

## 4. Розміщення файлів, discovery та extraction

### 4.1. Структура цільового проєкту

| Шлях | Призначення |
| --- | --- |
| `src/modules/quota/.design/design.mdx` | Авторський опис квоти, TS-контракти та приклади |
| `src/modules/quota/.design/design.generated.ts` | Похідні типи; змінює лише `design extract` |
| `src/modules/quota/memory-quota.ts` | Реалізація |
| `src/modules/quota/quota.test.ts` | Звичайні тести |
| `src/modules/mail/.design/design.mdx` | Дизайн відправника |
| `src/modules/campaigns/.design/design.mdx` | Дизайн сценарію відправлення |
| `src/modules/campaigns/send-service.ts` | Реалізація сценарію |
| `tests/integration/send.test.ts` | Допустиме місце інтеграційного тесту |
| `.design/config.json` | Необов’язкова конфігурація discovery та перевірок |

Маркер модуля — `.design/design.mdx`. Коренева `.design/config.json` сама по собі не створює модуль. Для малого проєкту допустимий один `src/.design/design.mdx`. Реалізації й тести не переносяться до MDX.

1. Батьківський каталог `.design` — корінь модуля; його project-relative path є module ID.
2. Файл належить найближчому модулю-предку. Вкладений модуль має власну область без дублів.
3. Ownership файлу не обмежує `@implements` чи `@tests`: реалізація/тест може лежати поза модулем контракту.
4. MDX та generated TS зберігаються в Git. Dot-каталоги явно включаються у discovery.
5. На модуль є один source-документ. Split documents, MDX includes та barrel/re-exports поза MVP.
6. Дизайн описує довгоживучу межу модуля; не створювати копії на кожен PR.
7. Generated TS не індексується вдруге як дизайн і не сканується як реалізація.

### 4.2. Конфігурація

Робочий каталог CLI — project root; альтернативний задається `--root`. Шлях `--config` і всі config paths трактуються від project root.

```json
{
  "version": 1,
  "tsconfig": "tsconfig.json",
  "designs": ["src/**/.design/design.mdx"],
  "implementations": ["src/**/*.ts"],
  "tests": ["src/**/*.test.ts", "tests/**/*.test.ts"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"],
  "testAdapter": "node:test"
}
```

Без `--config` шукати `.design/config.json`; якщо його немає, використовувати defaults вище. Явно переданий відсутній config, unknown fields, неправильні типи/версія/adapter — помилки. `exclude` замінює default-масив.

З implementation candidates автоматично вилучаються tests і всі файли в `.design`. `.d.ts` не скануються як реалізації/тести, але compiler може читати їхні типи.

Discovery deduplicate-ить канонічні paths, стабільно сортує їх і не обходить symlink поза project root. Для запису generated output також заборонено переходити через symlink. Source design поза scope не підключається автоматично: `E_DESIGN_OUT_OF_SCOPE`.

Нуль MDX-дизайнів або нуль контрактів у всьому scope — помилка. Data-only модуль допустимий, якщо у scope є хоча б один контракт. Кожний знайдений MDX має хоча б один непорожній `ts design` блок.

### 4.3. Вхідні блоки

| Форма | Семантика |
| --- | --- |
| Fenced-блок з language `ts` і meta `design` | Контрактний source; витягти до TS-модуля |
| Звичайний fenced `ts` / `typescript` | Приклад; не індексувати контракти, теги чи test bindings із нього |
| Проза, таблиці, Mermaid | Контекст для людини/LLM; не виконуються і не рахуються тестами |
| JSX, expressions, MDX ESM | Parsing як частини MDX; не виконуються, не резолвляться як залежності контрактів |

`ts design` — metadata code fence, не дев’ята JSDoc-директива. Порівнювати `lang === "ts"` та trimmed `meta === "design"` case-sensitive. Reserved meta `design` з іншою мовою — помилка. Інші code blocks є документацією; харнес не вгадує авторський намір за текстом прикладу.

MVP приймає лише fenced design blocks верхнього рівня документа, без відступу. Позначений блок у list/blockquote/JSX wrapper — `E_DESIGN_BLOCK_LOCATION`. Підтримати backtick/tilde fences стандартного parser; fences не включати до TS source. Кожний блок містить завершені TS declarations/imports: не розривати interface, comment чи signature між блоками.

Усі позначені блоки одного MDX в порядку появи утворюють один TS-модуль: оголошений вище DTO доступний нижче. Повторне ім’я не стає окремою сутністю через інший heading. Звичайний code example може містити невалідний TS — його не typecheck-ити як контракт.

Прямий `export interface` поза code fence не є підтримуваним способом оголошення контракту: MDX не надає нативного TS syntax [9]. Не компенсувати це запуском MDX або stripping усього документа як JavaScript.

### 4.4. Extraction і generated TS

Використати готовий Markdown/MDX AST parser, наприклад `unified` + `remark-parse` + `remark-mdx`; для GFM tables — `remark-gfm`. Конкретні сумісні версії зафіксувати. Використовувати parse/AST, не `evaluate`, `run`, JSX rendering чи runtime import документа. Не завантажувати executable MDX/remark config із цільового проєкту.

Порядок роботи:

1. Розпарсити MDX; syntax errors повернути з source location.
2. Вибрати design blocks за правилами 4.3, зберегти source ranges.
3. Нормалізувати CRLF → LF; зберегти текст і JSDoc усередині блоків без форматування, перейменувань або переписування imports. Для складання видалити лише кінцеві LF кожного block value; початкові порожні рядки, внутрішні відступи та пробіли зберегти.
4. Побудувати module text: два рядки ownership header, один порожній рядок, block values, з’єднані `\n\n`, та один кінцевий `\n`.
5. Для кожного скопійованого range зберегти mapping generated offsets → MDX offsets, враховуючи line endings. Header/separators не мають авторського TS range.
6. Створити для всіх дизайнів compiler overlay за їхніми майбутніми `design.generated.ts` paths. Потім перевіряти TS/imports; фізичні outputs ще не потрібні.
7. Валідатор metadata читає тільки вибрані блоки. JSDoc із кінця одного блока не може анотувати declaration іншого.

Generated file починається з двох фіксованих рядків:

```ts
// @generated by design; DO NOT EDIT.
// Source: design.mdx
```

Source path відносний до output directory, тому переміщення всього модуля не створює абсолютних paths. Header є технічним маркером власності файла, не harness-директивою. Не додавати timestamps, випадкові ID чи source-content hashes: зміна лише прози не повинна змінювати generated TS.

`design extract` попередньо перевіряє design-фазу всього scope, потім записує тільки відсутні/змінені outputs. За design errors або конфлікту власності не пише нічого. Повторний запуск на незмінному коді не переписує файли. Заміна кожного output атомарна; глобальну filesystem-транзакцію не обіцяти. I/O failure повертає exit 2 і список уже записаних/незаписаних outputs.

Якщо цільовий output уже існує без очікуваного ownership header, видати `E_GENERATED_CONFLICT` без перезапису. Файл із валідним header є керованим artifact: `extract` відновлює його з MDX, навіть якщо його хтось редагував вручну. Інші TS-файли не чіпати.

`design extract --check` нічого не пише. Для кожного source обчислює очікуваний output та порівнює з диском після нормалізації LF/CRLF. Missing output — `E_GENERATED_MISSING`; відмінний — `E_GENERATED_STALE`; ownership conflict — `E_GENERATED_CONFLICT`. Відсутність чи застарілість source map не перевіряється: mapping обчислюється з актуального MDX щоразу і не зберігається окремим artifact.

CLI не видаляє outputs після видалення/перенесення source. При зміні модуля агент явно видаляє або переносить пару source/generated. Mapping і registry будуються лише для знайдених MDX; orphan output ніколи не реєструється як source. Автоматичний cleanup/manifest поза MVP.

### 4.5. Діагностики та редактор

Усі diagnostics харнесу про контракт ведуть на початковий `design.mdx`, включно з TS syntax/type errors у другому чи наступних блоках. Помилки реалізацій/тестів ведуть на їхні `.ts`; related contract location — на MDX. Для header/separator diagnostics, що не мапляться на авторський range, вказати source document і пояснення, не вигадувати точну позицію.

Generated TS дає звичайні imports та типи редактору/`tsc` після extraction. Це не автоматична підтримка rename/navigation/type hints усередині MDX fences. Звичайний `tsc` може показувати generated TS location; перенаправлення на MDX гарантує наш CLI. Language-service plugin і live generation під час набору поза MVP.

Якщо змінюється проза або позиція блока, а TS-текст незмінний, generated output залишається тим самим; source mappings та review context оновлюються з нового MDX.

## 5. Бізнес-опис і джерела правди

`design.mdx` читають людина та LLM. Порядок секцій довільний: контекст можна розміщувати перед і після відповідного `ts design` блока. Структура прози рекомендована, але не є новою машинною мовою. Достатньо:

1. Мета й межі відповідальності модуля.
2. Терміни, потрібні для розуміння правил.
3. Основні сценарії та взаємодія контрактів.
4. Конкретні приклади, помилки й граничні випадки.
5. Відкриті питання та припущення.

Для умов використовуй речення «за умови → при події → результат»; для прикладів — Given/When/Then або таблиці; для життєвого циклу — стани й переходи. Не вимагай усіх форматів одночасно. Не перетворюй опис на псевдокод із внутрішніми функціями, SQL і деталями DI.

Кожне зобов’язання, для якого потрібна перевірка наявності тесту, формулюється в `@invariant` відповідального контракту/методу. `design.mdx` пояснює його й наводить приклади. Інваріанти різних контрактів у прозі можна розрізняти як `Quota: empty` або `Send: quota`; це звичайний текст, не новий синтаксис тегів.

Не підтримувати вручну два незалежні повні каталоги однакових вимог. Якщо опис і контракт суперечать один одному, LLM повідомляє про розбіжність; харнес не визначає автоматично, який текст бізнесово правильний.

Сценарій через кілька модулів має одного власника. Порядок «взяти квоту, потім відправити» належить `Send`, обмеження конкурентного списання — `Quota`.

Markdown-таблиця чи Mermaid-діаграма не рахується тестом. Наявність правила лише в Markdown не дає тестової прив’язки; LLM звертає увагу на суттєві правила, які ще не потрапили в контракт.

Heading або сусідня проза автоматично не підставляється в `@description`: короткий опис залишається всередині TS, щоб виділений контракт був самодостатній. Імена інваріантів не виводяться з headings. `@description` та `@invariant` мають ту саму семантику, що й раніше.

Якщо поза code blocks немає жодного paragraph/list/table з непорожнім текстовим вмістом (самого заголовка недостатньо), видати `W_BUSINESS_CONTEXT_MISSING`. Це структурний сигнал про відсутній контекст, не перевірка якості бізнес-опису. Порожній чи суперечливий за змістом опис оцінює LLM.

## 6. Формат контрактів і тегів

### 6.1. Декларації

Код у позначених `ts design` блоках містить type-only imports, exported interface/type declarations і коментарі. Виконувані declarations, side-effect imports, класи, функції, enum та value imports усередині контрактних блоків заборонені. Стандартні типи `Promise`, `Date`, `Readonly` доступні через TypeScript.

Кожна exported declaration має рівно один маркер: `@contract` або `@data`. Для `@data` дозволені interface та type alias; TypeScript перевіряє їхній тип. `@data` — DTO/форма даних, не рядок БД і не прив’язка до ORM.

`@contract` підтримує дві форми:

```ts
/**
 * @contract
 * @description Зберігає та читає значення за ключем.
 */
export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
```

```ts
/**
 * @contract
 * @description Нормалізує пробіли в заголовку.
 * @invariant spaces Прибирає крайові пробіли та стискає внутрішні до одного.
 */
export interface CleanTitle {
  (input: string): string;
}
```

Об’єктний контракт має один або більше звичайних обов’язкових named methods. Callable-контракт має один call signature без methods. Optional/computed methods, index signatures, public data properties, generics, extends та overloads відхиляються як непідтримуваний піднабір. Ці обмеження не поширюються на звичайні DTO-типи `@data`.

### 6.2. Словник

| Тег | Де | Значення |
| --- | --- | --- |
| `@contract` | Exported interface у `ts design` | Зареєструвати контракт |
| `@data` | Exported interface/type у `ts design` | Публічна форма даних |
| `@description текст` | Contract/data; опційно method/call signature | Непорожній опис призначення |
| `@uses A B` | Contract | Задекларовані контрактні колаборатори |
| `@invariant id текст` | Contract або method/call signature | Поведінкове зобов’язання з коротким ID |
| `@implements A` | Exported class/function/const у звичайному `.ts`, поза `.design`/tests | Реалізація контракту A |
| `@tests A` | Коментар над suite declaration | Контекст контракту для вкладених тестів |
| `@covers a b` | Коментар над test declaration | Прив’язка тесту до інваріантів контексту |

Теги case-sensitive. Контракт отримує ім’я TS-декларації; `@name` відкладено. Два контракти з однаковим ім’ям — помилка без правила «обрати найближчий». Замість двох `Store` використовуй `CampaignStore` і `MessageStore`. Однакові імена `@data` у різних модулях дозволені: їх резолвить TypeScript, вони не є адресами harness-тегів.

ID інваріанта відповідає `^[a-z][a-z0-9-]*$`; приклади `quota`, `empty`, `race`, `sender-error`. ID унікальний у всьому контракті. Однаковий ID у різних контрактах дозволений. Зміна тексту з тим самим ID зберігає прив’язки; MVP не визначає, чи старі тести залишилися достатніми.

Повторювані `@invariant`, `@uses` і `@covers` дозволені. Списки uses/covers приймають пробіли або коми; повторні посилання deduplicate-яться. `@implements` і `@tests` приймають рівно одне ім’я. Повторні `@description`, `@implements`, `@tests` на одній декларації — помилка. Порожній тег або інваріант без ID/тексту — помилка.

### 6.3. Коментарі й AST

- Використовувати TypeScript parser; не шукати весь протокол одним regex по тексту.
- Брати найближчий JSDoc-блок `/** ... */` безпосередньо перед підтримуваною декларацією або expression statement тесту/suite. Whitespace дозволений; інший коментар чи statement розриває прив’язку.
- Усередині блоку тег починається з нового логічного рядка після видалення JSDoc-відступу та `*`. Однорядковий `/** @implements A */` теж підтримується.
- Продовження тексту належить попередньому тегу до наступного рядка-тегу. Email або `@` усередині речення не створює тег.
- Інваріант методу зберігає `member` у моделі, але не створює namespace.
- Теги не зчитуються зі string literals, MDX-прози, звичайних example code blocks, тіла test callback чи довільного коментаря всередині методу. Виняток для MDX лише один: позначені `ts design` блоки аналізуються як TS source.
- Розпізнаний harness-тег у невірному місці дає діагностику, не пропускається мовчки.
- У design JSDoc і блоках із harness-тегами перевіряти невідомі теги. Дозволити стандартні `@param`, `@returns`, `@return`, `@example`, `@deprecated`, `@remarks`, `@see`, `@throws`, `@typeParam`, `@template`. Інші — `E_UNKNOWN_TAG`. Звичайні JSDoc-блоки репозиторію не лінтувати.
- `@name`, lock-теги та інші відкладені можливості дають `E_UNSUPPORTED_TAG`; не вдавати, що вони enforce-яться.

TypeScript може спеціально трактувати JSDoc `@implements`; наш parser зберігає його текстовий ідентифікатор незалежно від native implements/heritage nodes. Потрібен regression fixture для цього випадку.

У MDX не дублювати ці теги через JSX-компоненти, frontmatter чи окрему таблицю metadata. Повний словник — наведені вісім директив; `ts design` лише вибирає source blocks.

## 7. Реалізації та TypeScript-перевірка

```ts
/** @implements Store */
export class MemoryStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}
```

```ts
/** @implements CleanTitle */
export function cleanTitle(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}
```

Exported `const` допустимий, якщо variable statement містить одну named declaration без destructuring. Для об’єкта порівнюється object type; для функціонального значення — callable type. Anonymous/default export, factory binding та module-as-implementation поза MVP. Class, який не є callable, не може реалізувати callable-контракт.

Реалізація не імпортує контракт лише заради тегу. Потрібні DTO/контрактні типи імпортуються з `./.design/design.generated.js` у компільованому ESM або з `.ts` за відповідної конфігурації; не з `.mdx`. Для параметрів і залежностей звичайні `import type` доречні. Приклади не використовують native `implements`; якщо наявний код його вже має, CLI не переписує й не забороняє його, але binding однаково потребує коментаря.

### Алгоритм

1. Прочитати tsconfig через TypeScript API, з урахуванням `extends` та module resolution.
2. Спочатку виділити всі дизайни в пам’яті, створити Program без emit із compiler overlay на generated paths. Резолвити типи compiler-ом, без runtime import файлів користувача.
3. Для контракту отримати declared interface type. Для class — instance type, не static/constructor type; конструктор не викликати. Для function/const — тип значення.
4. Перевірити assignability у напрямку `implementation → contract`. Не вимагати зворотної assignability або текстової рівності сигнатур.
5. Використати доступний typed Compiler API або віртуальний typed assignment у пам’яті. Не використовувати undocumented API через `as any`. Вибраний механізм зафіксувати й перевірити на встановленій версії TypeScript.
6. Для virtual-file підходу забезпечити правильні imports/module resolution і mapping діагностики на початкові файли. Не створювати файли в репозиторії для перевірки.
7. Compiler diagnostics не приховувати. У звіті TS-помилки мають окремий код та оригінальний TS-код.

Додаткові public methods реалізації допустимі. Приватні члени й constructor dependencies не є частиною interface-контракту. Abstract/generic implementation classes та overloaded implementation functions поза MVP; не вгадувати параметри типів.

Design-фаза будує Program із віртуальних generated roots та їх type dependencies; реалізації/тести й наявність фізичних generated outputs не потрібні. Implementation-фаза включає файли tsconfig плюс generated/implementation/test roots, навіть якщо їх не було у `include`. У кожній фазі CompilerHost використовує свіжий in-memory текст замість stale disk artifact. File existence, читання та module resolution мають бачити overlay, навіть коли generated TS ще не створено на диску. Compiler options беруться з цільового проєкту; змінюються лише параметри для `noEmit`. Невалідні compiler options — помилка середовища.

Рекомендований `strict: true`. Якщо `strictNullChecks`, `strictFunctionTypes` або `noImplicitAny` ефективно вимкнені, видати `W_WEAK_TYPECHECK` і записати значення у звіт; не змінювати непомітно політику проєкту.

**Межа гарантії:** стандартна TypeScript assignability. `any`, assertions, suppression-коментарі й особливості variance методів можуть послабити перевірку; навіть `strictFunctionTypes` не робить звичайні methods повністю строгими. Власна система soundness або type linter до MVP не входить. Ці випадки мають fixtures й описані в README [1–3].

Freshness-check фізичних outputs — окрема діагностика. За stale/missing output не можна typecheck-ити старий TS і проголошувати відповідність актуальному дизайну. Водночас overlay не змінює файлів проєкту. Реєстр контрактів створюється один раз із MDX і прив’язується до символів відповідного generated module.

## 8. Тестові декларації та прив’язки

Базова форма — `@tests Quota` над `describe`, `@covers empty` над вкладеним `it`. Повний виконуваний приклад наведено в розділі 13.

1. `@tests Contract` встановлює контекст suite. Вкладені suite успадковують його; новий `@tests` перевизначає лише своє піддерево.
2. `@covers` дозволений над test declaration у контексті suite. На suite, helper або тесті без контексту — помилка.
3. Кожен інваріант на implementation-фазі потребує хоча б одну прив’язану декларацію. Один тест може задовольняти кілька інваріантів.
4. Unknown contract/invariant — помилка без fallback за схожим текстом.
5. Тести без harness-тегів не потребують анотацій. Контекстний тест без covers не створює зв’язку.
6. Interface-level інваріанти не дублюються на methods; наявність перевіряється один раз за ID.
7. Зв’язок контракт → інваріант → тест не означає зв’язок із конкретною реалізацією. Для кількох реалізацій MVP перевіряє загальну наявність; повноту тестів кожного адаптера оцінює LLM.
8. Тест може лежати поза boundary контракту, зокрема у `tests/integration`. Не вимагати саме unit-тест.

### Адаптер `node:test`

- Named imports `describe`, `suite`, `it`, `test`, import aliases, default import `test` і namespace import з точного модуля `node:test`.
- Розпізнавання за imported binding/symbol, а не рядком назви `it`. Локальна функція `it` або затінений параметр не є тестом.
- Прямі виклики та суфікси `.skip`, `.only`, `.todo`. Суфікси допомагають розпізнати declaration; runtime-стан не оцінюється.
- Назва анотованого suite/test — string literal або template literal без interpolation. Інші форми — явна unsupported-form діагностика.
- Suite callback — inline function/arrow. Callback тесту може бути inline або identifier; для skip/todo його може не бути. Assertions/наявність callback не є критерієм якості.
- Standard optional options argument підтримується без виконання й аналізу `skip`/`todo`.
- Статичні declarations в умовах/циклах індексуються як один AST-вузол; не обіцяти runtime registration та не множити кількість за ітераціями.
- Не викликати callbacks/runner API. Wrappers, custom re-exports test API, `t.test` subtests та генерація suite через helper поза MVP. Harness-тег на такій формі дає помилку.
- Після переходу у test callback не шукати вкладені suite/test як root declarations. AST range тіла зберігається для review context.

## 9. Взаємодія дизайнів і граф

У `ts design` дозволені type-only imports із `design.generated.ts` іншого модуля, source MDX якого знайдено у scope. Source-to-output mapping відомий discovery до запуску compiler. Імпорти реалізацій, ORM-схем, тестів, composition root і сторонніх package types у design для MVP заборонені. Якщо потрібна зовнішня форма, опиши незалежний DTO на межі. Це обмеження першої версії, не TypeScript. Для простоти MVP inline import types на кшталт `import("./file").Type` відхиляються: залежності мають бути видимими у звичайних type-only import declarations. TypeScript `paths` aliases дозволені, якщо резолвляться у generated module зі знайденим source MDX. Bare import type з `.mdx` заборонений у MVP: власний MDX module resolver не потрібен.

Приклад import усередині `campaigns/.design/design.mdx`:

```ts
import type { Message } from "../../mail/.design/design.generated.js";
```

Цей рядок має бути всередині позначеного блока. Відносний шлях лишається незмінним після extraction, бо generated TS лежить поруч із MDX. TypeScript резолвить `.js` до `.ts` за конфігурацією проєкту; fixture нижче використовує `.ts` imports із `allowImportingTsExtensions`. Source іншого модуля індексується з MDX, не з generated artifact.

`@uses Quota Sender` резолвиться registry контрактів і не потребує невикористаних TS imports. Тип у сигнатурі імпортується звичайним `import type`; aliases резолвить TypeScript.

Два види ребер:

- `uses`: контракт → задекларований контрактний колаборатор.
- `type-import`: source-модуль → source-модуль, на generated types якого посилається контрактний блок. MDX ESM imports компонентів не є ребрами контрактного графа.

`type-import` — граф декларацій імпортів, а не точний граф використаних типів: невикористаний import теж створює ребро. Це не runtime call graph. Повний impact analysis та compiler references поза MVP.

Міжмодульний граф агрегує обидва види. Цикл із двох або більше модулів — `E_DESIGN_CYCLE` зі шляхом циклу. Ребра всередині модуля не створюють міжмодульний цикл. Безпосередній `@uses` на самого себе — помилка посилання.

`@uses` декларує допустимих колабораторів. MVP перевіряє адресата, але не доводить, що код викликає лише ці контракти, і не контролює всі imports реалізацій. Окремий dependency/boundary checker можна додати пізніше.

### Mermaid

Будується з тієї самої моделі, без LLM. Показує модулі та ребра з labels `uses`, `types` або `uses, types`; ізольовані модулі теж видно. JSON зберігає конкретні контракти та locations ребер.

Node IDs стабільні; labels екрануються. Не вставляти raw JSDoc, HTML, click directives або per-diagram configuration. Діаграма показує статичний дизайн, не порядок викликів, бізнес-процес або результати тестів.

## 10. CLI і фази

`check`, `inspect`, `graph`, `review` та `extract --check` read-only. Лише явний `extract` записує керовані generated outputs за правилами 4.4. Немає init, autofix або генерації реалізацій. Звіти — stdout; довільні export files записує користувач перенаправленням.

| Команда | Призначення |
| --- | --- |
| `design extract` | Перевірити design-фазу й синхронізувати `design.generated.ts` у всьому scope |
| `design extract --check` | Перевірити design і актуальність outputs без запису |
| `design check --phase design` | MDX/blocks, metadata, design types, references, scope, graph/cycles; generated файли не потрібні |
| `design check` | Default implementation-фаза: усе попереднє, freshness outputs, implementations, TS-сумісність, tests/covers |
| `design check --phase implementation --format json` | Машинний звіт повної статичної перевірки |
| `design inspect` | Перелік модулів/контрактів та counts |
| `design inspect Send` | Members, invariants, dependencies, implementations, test links |
| `design graph --format mermaid` | Міжмодульний граф; default format для graph |
| `design graph --format json` | Графова модель у JSON |
| `design review Send --format markdown` | Source MDX, код, тести й інструкція LLM; default format для review |
| `design review Send --format json` | Структурований packet без виклику моделі |

Загальні flags: `--root <path>`, `--config <path>`, `--help`, `--version`. Check/inspect/extract підтримують `--format text|json`. `--check` дозволений лише для extract; `--phase` — лише для check. Невідомі flags/комбінації — помилка.

### Фази та актуальність

- Design-фаза не сканує implementation/test tags, не вимагає реалізацій/тестів і не перевіряє наявність/актуальність фізичних generated файлів. Її типи завжди беруться зі свіжих extracted blocks.
- Implementation-фаза перевіряє весь scope та повідомляє stale/missing/conflicting outputs. `check Send` не підтримується.
- Inspect/review працюють зі свіжим in-memory дизайном. Відсутні реалізації/тести або stale outputs не блокують export; structural diagnostics додаються, `complete: false` означає їх наявність.
- Graph використовує design-фазу без freshness gate: новий MDX можна переглядати до extraction. Невалідний design index/цикл дає помилку.
- Extraction потребує валідного design scope, але не готових implementations/tests. `extract --check` не є перевіркою їх відповідності.

### Exit codes

| Код | Значення |
| --- | --- |
| `0` | Перевірка успішна; export виконано; або extraction успішно синхронізував outputs |
| `1` | Порушення правил, stale/missing/conflicting generated output, невідомий контракт або неможливість побудувати graph |
| `2` | Некоректні args/config, недоступний tsconfig, несумісне середовище, I/O/internal error |

Для inspect/review exit 0 означає успішний export, не успішний check; diagnostics і `complete` обов’язкові. Warnings не змінюють exit code. Не додавати strict-політику для skip/todo.

JSON stdout містить рівно один об’єкт без ANSI/logs. Extraction report має schemaVersion, command, checkOnly, ok, output entries зі source/path/status та diagnostics. Статуси — `written`, `unchanged`, `missing`, `stale`, `conflict`; per-file I/O failure позначається явно. Це стан generated artifact, не test run. Порядок стабільний, без timestamps/UUID.

### Робочий цикл

1. Змінити prose/`ts design` у source MDX.
2. `design check --phase design` — перевірити проектований контракт.
3. `design extract` — оновити типи для редактора й звичайного `tsc`.
4. Змінити реалізації та tests у звичайних `.ts`.
5. `design check` — перевірити структуру та наявність прив’язок.
6. Передати `design review <Contract>` LLM для змістового рев’ю.
7. Окремо запустити звичайні typecheck/test/lint команди проєкту.

У CI `design extract --check` перевіряє committed outputs без їх регенерації; далі `design check` і власні команди проєкту. Ніколи не підміняти freshness gate генерацією з подальшим мовчазним прийняттям diff.

## 11. Архітектура ядра та звітів

Один npm-пакет. Не робити monorepo, сервер, public plugin SDK або багатомовну абстракцію наперед.

| Частина | Відповідальність |
| --- | --- |
| `config` | Defaults, JSON validation, нормалізація paths |
| `discovery` | MDX sources, source/output mapping, module ownership, excludes |
| `mdx` | Parse-only AST, root design blocks, business context, MDX positions |
| `extraction` | Детермінований TS text, segment mappings, freshness та керований запис |
| `typescript` | Compiler overlay, TS AST/symbols, module resolution, assignability |
| `metadata` | Єдиний parser тегів і source locations |
| `registry` | Contracts, data, invariants, implementations |
| `test-declarations/node-test` | Suite/test declarations і контекст @tests |
| `validation` | Правила, links, diagnostics |
| `graph` | Declared edges, module aggregation, cycles |
| `report` | Text/JSON/Mermaid та review packet |
| `cli` | Args, фази, output, exit codes |

Це відповідальності, не вимога створити клас для кожного рядка. Чисті функції й прості структури даних достатні.

### Модель

| Сутність | Мінімальні поля |
| --- | --- |
| Module | root, sourceMdxFile, generatedTsFile, designBlocks, hasBusinessContext |
| DesignBlock | source range, order, raw TS text, generated range |
| ExtractedModule | source/output paths, expected text, segment mapping, artifact status |
| Contract | name, module, description, shape, declaration/member locations |
| Data | module, name, description, location |
| Invariant | contract, id, text, member або null, location |
| Implementation | contract, exported symbol, kind, location, compatibility result |
| TestDeclaration | source range, title, suite path, adapter, contract context, covers[] |
| Edge | kind, from/to, source location |
| Diagnostic | code, severity, message, location, related locations, contract/invariant за потреби |

Внутрішній ключ інваріанта — пара `(contract, id)`, не namespace для користувача. Ключ test declaration — path та AST range поточного snapshot; це не ID тестового запуску.

Location: path від project root у POSIX-форматі; line/column — 1-based; TS offsets у UTF-16, end exclusive. Parser positions треба узгодити з цією конвенцією; окремо протестувати Unicode та CRLF. Для контрактів public location веде на MDX; generated range зберігається лише як допоміжний для compiler mapping. Diagnostics сортуються за file/start/code. Duplicate edges/links не збільшують counts.

### Приклад JSON check report

```json
{
  "schemaVersion": 1,
  "command": "check",
  "phase": "implementation",
  "ok": false,
  "scope": {
    "tsconfig": "tsconfig.json",
    "designFiles": ["src/modules/campaigns/.design/design.mdx"]
  },
  "generatedArtifacts": [
    {
      "source": "src/modules/campaigns/.design/design.mdx",
      "file": "src/modules/campaigns/.design/design.generated.ts",
      "status": "current"
    }
  ],
  "counts": {
    "contracts": 1,
    "invariants": 2,
    "implementations": 1,
    "testDeclarations": 1,
    "linkedInvariants": 1
  },
  "invariants": [
    { "contract": "Send", "id": "quota", "member": "run", "linkedTestCount": 1 },
    { "contract": "Send", "id": "limit", "member": "run", "linkedTestCount": 0 }
  ],
  "diagnostics": [
    {
      "code": "E_TEST_MISSING",
      "severity": "error",
      "message": "Invariant Send: limit has no linked test declaration.",
      "file": "src/modules/campaigns/.design/design.mdx",
      "line": 8,
      "column": 6,
      "contract": "Send",
      "invariant": "limit"
    }
  ]
}
```

Це макет форми, не результат роботи готового CLI. На design-фазі generated artifact status = `not-checked`; на implementation-фазі — `current`, `missing`, `stale` або `conflict`. Реальний report додає effective compiler options, фактичні locations та summary warnings. На design-фазі неперевірені implementations/test counts і `linkedTestCount` мають `null`, не 0: «не перевіряли» відрізняється від «не знайшли».

Не додавати `passed`, `failed`, `proven`, `testRunStatus` або відсоток runtime coverage. Текст каже «2 linked declarations», не «інваріант доведений».

### Діагностики

| Код | Умова |
| --- | --- |
| `E_CONFIG` / `E_ENVIRONMENT` | Невалідна конфігурація/середовище |
| `E_NO_DESIGNS` / `E_NO_CONTRACTS` | Порожній discovery відповідного рівня |
| `E_MDX_SYNTAX` | MDX parse error з авторською location |
| `E_DESIGN_BLOCK_MISSING` / `E_DESIGN_BLOCK_EMPTY` | Немає непорожнього позначеного source блока |
| `E_DESIGN_BLOCK_MARKER` / `E_DESIGN_BLOCK_LOCATION` | Reserved marker з іншою мовою або недопустиме вкладення |
| `E_GENERATED_MISSING` / `E_GENERATED_STALE` / `E_GENERATED_CONFLICT` | Проблема фізичного output, без підміни source MDX |
| `E_TAG_FORMAT` / `E_TAG_LOCATION` | Невірний формат/місце тегу |
| `E_UNKNOWN_TAG` / `E_UNSUPPORTED_TAG` | Невідомий тег/відкладена можливість |
| `E_UNSUPPORTED_DECLARATION` | Декларація поза TS/test піднабором |
| `E_DESCRIPTION_MISSING` | Немає обов’язкового опису |
| `E_CONTRACT_DUPLICATE` / `E_INVARIANT_DUPLICATE` | Неоднозначний ключ |
| `E_REFERENCE_UNKNOWN` | uses/implements/tests/covers не резолвиться |
| `E_DESIGN_IMPORT` / `E_DESIGN_OUT_OF_SCOPE` | Недопустима залежність design |
| `E_DESIGN_CYCLE` | Міжмодульний цикл |
| `E_IMPLEMENTATION_MISSING` | Немає позначеної реалізації |
| `E_TYPE_MISMATCH` / `E_TYPESCRIPT` | Несумісність із контрактом/TS diagnostic |
| `E_TEST_CONTEXT` / `E_TEST_MISSING` | Немає контексту/прив’язки |
| `W_BUSINESS_CONTEXT_MISSING` / `W_NO_INVARIANTS` | Неповний опис поведінки |
| `W_WEAK_TYPECHECK` | Послаблені compiler options |

Уникати каскаду похідних помилок: якщо `@tests Unknown` не резолвиться, не повідомляти окремо про кожен його covers. Primary diagnostic вказує причину.

## 12. Контекст для LLM-рев’ю

`design review Send` нічого не відправляє в мережу. Експортує:

1. Повний авторський `design.mdx` модуля: проза, контрактні блоки, приклади та відкриті питання.
2. Індекс вибраного контракту, інваріанти та ranges у source MDX; за відсутності бізнес-прози — explicit missing context.
3. Source MDX прямих uses-залежностей і type-import closure. Не підміняти ці матеріали generated TS.
4. Повні source files позначених реалізацій вибраного контракту.
5. Повні source files прив’язаних тестів, включно з видимими setup/hooks/imports; ranges конкретних declarations.
6. Прямі/зворотні declared dependencies. Це не повний impact analysis.
7. Structural diagnostics і відсутні прив’язки.
8. Інструкцію рев’ю та формат висновків.

Source MDX включається один раз: не дублювати його як prose-файл, extracted blocks і весь generated TS одночасно. Файли deduplicate-яться. Source blocks містять path/ranges. JSON зберігає raw content; Markdown обирає fence довший за наявні в контенті. Не обрізати файли мовчки. Token-budget summarization і рекурсивний збір усіх implementation dependencies поза MVP.

Не підключати `.env`, credentials, історію Git чи весь репозиторій. Імпортовані test helpers поза зібраними файлами перелічуються як непідвантажений контекст. LLM відкриває їх у репозиторії або відмічає недостатність матеріалів.

### Інструкція рев’юеру

Для кожного інваріанта оцінити:

- Чи тест викликає потрібну поведінку або належний зовнішній сценарій?
- Чи може виявити порушення саме цього твердження?
- Чи assertions спостерігають потрібний результат, порядок або ефект?
- Чи mocks не підміняють гарантію, яку тест нібито перевіряє?
- Чи враховано релевантні помилки, межі, конкуренцію або повтори?
- Чи interface-level правило перевіряється в потрібній взаємодії methods?
- Чи різні реалізації мають відповідні сценарії?
- Чи business description не містить додаткових суттєвих вимог/суперечностей?

Результат: `contract`, `invariant`, `assessment`, `reason`, `evidence`, `suggestedChange`. Assessment: `adequate`, `weak`, `unrelated`, `insufficient-context`. Це оцінка, не доказ або результат запуску. За відсутності інваріантів — зауваження рівня контракту.

LLM не видаляє інваріанти й не переписує бізнес-вимоги заради успішного check. Новий/слабкий тест — рекомендація для реалізації й перевірки звичайним test environment.

## 13. Повний вертикальний fixture

Один проєкт: 3 source MDX, 4 позначені TS-блоки, 3 контракти, 1 DTO type, 8 інваріантів і 8 прив’язаних test declarations. Quota має окремі блоки для AccountId та контракту; Send імпортує цей тип через generated module. Отже приклад перевіряє і спільний scope блоків, і міжмодульний type import. Sender без інваріантів дає очікуваний warning.

Нижче 10 авторських файлів. `design extract` додатково створює 3 generated TS, які не дублюються вручну в цьому документі. Це навчальна квота без добових вікон, persistent storage, мережевого провайдера або exactly-once гарантій.

Fixture використовує `.ts` import specifiers для Node 24 type stripping та має `noEmit`/`allowImportingTsExtensions`. Інші проєкти можуть використовувати звичайний компільований ESM із `.js` specifiers. Runtime виконання Node не замінює TypeScript check.

У прикладах MDX показаний усередині чотирьох backticks, щоб внутрішні `ts design` fences залишалися трьома. У самому файлі зовнішньої обгортки немає.

### `package.json`

```json
{
  "name": "contract-harness-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test src/modules/quota/quota.test.ts src/modules/campaigns/send.test.ts"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

### `src/modules/quota/.design/design.mdx`

````mdx
# Квота

Квота визначає кількість доступних спроб окремо для кожного акаунта.
Початковий залишок задає зовнішня конфігурація; у прикладі він цілий і невід’ємний.
Відновлення залишку, добові вікна та persistent storage поза цим прикладом.

Приклади для Quota.take:

| Правило | Початковий залишок | Дія | Очікування |
| --- | --- | --- | --- |
| empty | 0 | Один виклик | false |
| consume | 1 | Два послідовні виклики | true, потім false |
| race | 1 | Два конкурентні виклики | За відсутності технічних помилок рівно один true |

accounts стосується всього контракту: споживання у A не витрачає залишок B.

## Типи

```ts design
/**
 * @data
 * @description Ідентифікатор акаунта для обліку квоти.
 */
export type AccountId = string;
```

## Контракт

```ts design
/**
 * @contract
 * @description Обліковує доступні спроби окремо для кожного акаунта.
 * @invariant accounts Використання квоти одного акаунта не змінює квоту іншого.
 */
export interface Quota {
  /**
   * @description Намагається використати одну одиницю доступної квоти.
   * @invariant empty Для невідомого акаунта або нульового залишку повертає false без списання.
   * @invariant consume За додатного залишку повертає true та зменшує залишок на один.
   * @invariant race Паралельні виклики не можуть використати більше доступного залишку.
   */
  take(accountId: AccountId): Promise<boolean>;
}
```
````

### `src/modules/quota/memory-quota.ts`

```ts
/** @implements Quota */
export class MemoryQuota {
  private readonly remaining: Map<string, number>;

  constructor(initial: Record<string, number>) {
    this.remaining = new Map(Object.entries(initial));
  }

  async take(accountId: string): Promise<boolean> {
    const left = this.remaining.get(accountId) ?? 0;
    if (left <= 0) return false;
    this.remaining.set(accountId, left - 1);
    return true;
  }
}
```

### `src/modules/quota/quota.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryQuota } from "./memory-quota.ts";

/** @tests Quota */
describe("MemoryQuota", () => {
  /** @covers accounts */
  it("зберігає незалежний залишок акаунтів", async () => {
    const quota = new MemoryQuota({ a: 1, b: 1 });
    assert.equal(await quota.take("a"), true);
    assert.equal(await quota.take("a"), false);
    assert.equal(await quota.take("b"), true);
  });

  /** @covers empty */
  it("відмовляє для нульового та невідомого залишку", async () => {
    const quota = new MemoryQuota({ a: 0 });
    assert.equal(await quota.take("a"), false);
    assert.equal(await quota.take("a"), false);
    assert.equal(await quota.take("unknown"), false);
  });

  /** @covers consume */
  it("витрачає одну одиницю на успішний виклик", async () => {
    const quota = new MemoryQuota({ a: 1 });
    assert.equal(await quota.take("a"), true);
    assert.equal(await quota.take("a"), false);
  });

  /** @covers race */
  it("не перевищує залишок при паралельних викликах", async () => {
    const quota = new MemoryQuota({ a: 1 });
    const results = await Promise.all([quota.take("a"), quota.take("a")]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await quota.take("a"), false);
  });
});
```

### `src/modules/mail/.design/design.mdx`

````mdx
# Транспорт

## Контракт

```ts design
/**
 * @contract
 * @description Порт передачі текстового повідомлення обраному транспорту.
 */
export interface Sender {
  send(text: string): Promise<void>;
}
```

## Бізнес-контекст

Модуль надає порт Sender для передачі тексту налаштованому транспорту.
Приклад використовує callback-адаптер без мережевого провайдера.
Гарантії доставки, retries та дедуплікації у fixture не визначені.
````

### `src/modules/mail/callback-sender.ts`

```ts
/** @implements Sender */
export class CallbackSender {
  private readonly deliver: (text: string) => Promise<void>;

  constructor(deliver: (text: string) => Promise<void>) {
    this.deliver = deliver;
  }

  async send(text: string): Promise<void> {
    await this.deliver(text);
  }
}
```

### `src/modules/campaigns/.design/design.mdx`

````mdx
# Відправлення

## Контракт

```ts design
import type { AccountId } from "../../quota/.design/design.generated.ts";

/**
 * @contract
 * @description Виконує одну спробу відправлення за наявності квоти.
 * @uses Quota Sender
 */
export interface Send {
  /**
   * @description Отримує квоту та передає повідомлення відправнику.
   * @invariant quota Викликає Sender лише після завершення Quota.take з true.
   * @invariant limit За false від Quota повертає limited без виклику Sender.
   * @invariant quota-error При помилці Quota відхиляє виклик тією ж помилкою без виклику Sender.
   * @invariant sender-error При помилці Sender відхиляє виклик тією ж помилкою.
   */
  run(accountId: AccountId, text: string): Promise<"sent" | "limited">;
}
```

## Бізнес-контекст

Мета — дозволити спробу відправлення лише після отримання квоти акаунта.
Власник міжмодульного сценарію — Send.

Порядок взаємодії описує Send: quota; відсутність дозволу — Send: limit.
Відмови залежностей описують quota-error і sender-error.
Успішна передача транспорту повертає sent; це не гарантія доставки адресату.

Приклад limit:

- Given: Quota.take повертає false.
- When: викликається Send.run.
- Then: результат limited, транспорту нічого не передано.

Відкриті питання для майбутнього продукту:

- Чи відновлюється квота після підтвердженої помилки транспорту?
- Яка політика повторів після таймауту з невідомим результатом?

Відновлення квоти, retries та ідемпотентність не входять у fixture.
````

### `src/modules/campaigns/send-service.ts`

```ts
import type { Quota } from "../quota/.design/design.generated.ts";
import type { Sender } from "../mail/.design/design.generated.ts";

/** @implements Send */
export class SendService {
  private readonly quota: Quota;
  private readonly sender: Sender;

  constructor(quota: Quota, sender: Sender) {
    this.quota = quota;
    this.sender = sender;
  }

  async run(accountId: string, text: string): Promise<"sent" | "limited"> {
    if (!(await this.quota.take(accountId))) return "limited";
    await this.sender.send(text);
    return "sent";
  }
}
```

### `src/modules/campaigns/send.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SendService } from "./send-service.ts";
import { CallbackSender } from "../mail/callback-sender.ts";

/** @tests Send */
describe("SendService", () => {
  /** @covers quota */
  it("чекає на підтвердження квоти до передачі повідомлення", async () => {
    let release!: (allowed: boolean) => void;
    const permission = new Promise<boolean>((resolve) => { release = resolve; });
    const delivered: string[] = [];
    const quota = { take: async (_accountId: string) => permission };
    const sender = new CallbackSender(async (text) => { delivered.push(text); });
    const service = new SendService(quota, sender);
    const pending = service.run("a", "hello");

    await Promise.resolve();
    assert.deepEqual(delivered, []);
    release(true);
    assert.equal(await pending, "sent");
    assert.deepEqual(delivered, ["hello"]);
  });

  /** @covers limit */
  it("не передає повідомлення без квоти", async () => {
    let calls = 0;
    const quota = { take: async (_accountId: string) => false };
    const sender = new CallbackSender(async () => { calls++; });
    const service = new SendService(quota, sender);
    assert.equal(await service.run("a", "hello"), "limited");
    assert.equal(calls, 0);
  });

  /** @covers quota-error */
  it("передає помилку квоти без звернення до транспорту", async () => {
    const error = new Error("quota unavailable");
    let calls = 0;
    const quota = { take: async (_accountId: string): Promise<boolean> => { throw error; } };
    const sender = new CallbackSender(async () => { calls++; });
    const service = new SendService(quota, sender);
    await assert.rejects(service.run("a", "hello"), (actual) => actual === error);
    assert.equal(calls, 0);
  });

  /** @covers sender-error */
  it("передає помилку транспорту", async () => {
    const error = new Error("transport unavailable");
    const quota = { take: async (_accountId: string) => true };
    const sender = new CallbackSender(async () => { throw error; });
    const service = new SendService(quota, sender);
    await assert.rejects(service.run("a", "hello"), (actual) => actual === error);
  });
});
```

Агент додає сумісні перевірені `typescript` і `@types/node` у devDependencies та зберігає lockfile; не вигадувати версії. CLI встановлюється з реалізованого локального пакета.

Послідовність для майбутньої реалізації:

```sh
design check --phase design
design extract
design extract --check
design check
npm run typecheck
npm test
```

До extraction перша команда працює без фізичних generated TS. Після extraction очікуються 3 generated artifacts зі статусом current, 3 contracts, 1 data declaration, 8 invariants, 3 implementations та 8 linked declarations; `W_NO_INVARIANTS` для Sender; без structural errors. Node:test виконується окремо; харнес його результати не читає.

Додаткові fixtures: звичайний `ts` example із фальшивим @contract не індексується; зміна прози не змінює generated output; зміна DTO робить output stale; помилка у другому блоці Quota повідомляє MDX location.

## 14. План реалізації по етапах

Етапи послідовні. Кожен дає придатний до перевірки результат; не починати UI/automation замість завершення CLI.

| Етап | Що зробити | Критерій завершення |
| --- | --- | --- |
| 1. Каркас | npm package, TS build, CLI entry, config/defaults, tests інструмента | CLI працює після build; help є; args/config errors повертають 2 |
| 2. Discovery | MDX paths, dot-folders, source/output mapping, ownership, config | Nested module один; generated TS не дублює source; symlink не обходиться |
| 3. MDX/extraction | AST blocks, shared scope, deterministic output, mappings, extract/check | Кілька блоків утворюють один модуль; stale/missing/conflict та MDX positions перевірені |
| 4. Контракти | AST metadata, registry, member invariants, descriptions, IDs | Positive/negative syntax fixtures дають очікувані diagnostics/locations |
| 5. Design check | Compiler overlay, type imports, scope, uses, graph/cycles | Працює без generated файлів; compiler бачить актуальний MDX, а diagnostics повертаються у source |
| 6. Реалізації | implements, instance/function/object types, assignability | Коректні bindings проходять, missing methods/несумісні результати — errors |
| 7. Тестові прив’язки | node:test adapter, nested contexts, covers index | Missing/unknown links знайдено; skip/todo без runtime-політики |
| 8. Звіти | Стабільні text/JSON, inspect, exit codes | JSON чистий/повторюваний; немає false success на empty discovery |
| 9. Mermaid/review | Graph export, context packet, інструкція LLM | Єдина модель; context повний у заявлених межах |
| 10. Інтеграція | Fixture, негативні варіанти, README, npm tarball | Команди працюють із зібраного пакета; sources не змінюються |

На початку зафіксувати версії інструментів і підтримуваного TS API. Не писати власний Markdown/MDX/TypeScript parser чи test runner. Для globs/CLI parsing можна використовувати наявні бібліотеки репозиторію.

Першим технічним зрізом перевірити два MDX-блоки в одному модулі, import generated типу іншого модуля без фізичних outputs і TS diagnostic із правильною MDX location. Це знімає головний ризик нового формату до розробки решти CLI.

## 15. Acceptance matrix

Це перевірки реалізації харнесу його власним test environment. Вони не перетворюють продукт на runner користувацьких тестів.

| Сценарій | Очікування |
| --- | --- |
| Dot-каталог .design | MDX знаходиться за default pattern |
| MDX містить кілька ts design блоків | Один TS-модуль у document order; DTO доступний між блоками |
| Звичайний ts example містить @contract / @covers | Не індексується; не створює tests або contracts |
| Немає/порожній design block | E_DESIGN_BLOCK_MISSING / E_DESIGN_BLOCK_EMPTY |
| Reserved design meta на іншій мові | E_DESIGN_BLOCK_MARKER |
| Позначений блок у list/blockquote/JSX | E_DESIGN_BLOCK_LOCATION |
| MDX syntax error | E_MDX_SYNTAX з початковою location |
| Split declaration/comment між блоками | Явна помилка; немає cross-block JSDoc binding |
| Duplicate declaration у різних блоках | Compiler/registry error, не різні namespaces |
| Зміна лише прози / переміщення блока без зміни TS | Output current; mapping/review оновлені |
| Зміна contract text/invariant у блоці | Output stale до extraction |
| Відсутні generated outputs | Design-phase проходить через overlay; implementation/freshness check дає missing |
| Stale output має старий правильний тип | Перевіряється свіжий MDX, stale artifact не приховує нову помилку |
| Cross-module generated type import без дискових outputs | CompilerHost overlay правильно резолвить types |
| TS error у другому блоці / Unicode / CRLF | Точний source MDX range; не generated line |
| Output існує без ownership header | Conflict, жодного перезапису |
| Ручна зміна output із валідним header | Check дає stale; extract відновлює source-derived текст |
| Повторний extract | Unchanged outputs не переписуються |
| Design error у будь-якому модулі | Extract не пише outputs у всьому scope |
| I/O failure під час запису | Exit 2; per-file results показують можливий частковий запис |
| Видалення source MDX | Generated output не стає source і не видаляється автоматично |
| MDX component import | Не є type-import edge та не виконується |
| Generated TS і source MDX одночасно у glob/tsconfig | Contract registry не містить дублів |
| Parent і nested module | Найближчий owner, без дублів |
| Немає designs/контрактів | Помилка, не порожній success |
| Duplicate contract name | Error з обома locations |
| Однаковий invariant ID на інтерфейсі й методі | Duplicate error |
| Однаковий invariant ID різних контрактів | Валідно |
| Порожній description | Error для contract/data; на методі необов’язковий |
| Invariant без ID/тексту | Error |
| Multiline invariant | Правильний текст/location |
| Тег у string/неприв’язаний коментар | Не створює фальшивий link; misplaced known tag діагностується |
| Unknown tag у managed JSDoc | Error; неанотований код не лінтується |
| Class має метод лише static | Instance не відповідає контракту |
| Додатковий public method | Assignability проходить |
| Function/const та callable interface | Коректний binding |
| Несумісний return або missing method | E_TYPE_MISMATCH |
| any/assertions/method bivariance | Фіксується реальна TS-семантика; README не обіцяє її усунення |
| Native implements без тегу | Не створює binding |
| implements unknown contract | Reference error |
| Кілька реалізацій | Кожна перевіряється; один link не доводить tests усіх |
| Imported alias it as check | Розпізнається за binding |
| Локальна функція/параметр it | Не рахується тестом |
| Nested describe без tests | Успадковує контекст |
| Nested describe з іншим tests | Перевизначає своє піддерево |
| Кілька covers/ID на тесті | Усі links; дублікати не множать counts |
| covers на suite/helper/без context | Error |
| Unknown contract/invariant у тесті | Error без зайвого каскаду |
| Інваріант без тесту | Error лише implementation-фази |
| it.skip/it.todo/options.skip | Declaration враховується; runtime state не аналізується |
| Порожній callback/assert.ok(true) | Структурна прив’язка є; семантичної гарантії немає |
| Dynamic suite helper із тегом | Явна unsupported-form діагностика |
| Тест в іншому модулі/tests | Дозволений link |
| Design import реалізації/package type | E_DESIGN_IMPORT |
| Design import поза scope | E_DESIGN_OUT_OF_SCOPE |
| Type-only import між дизайнами | Type resolution і type-import edge |
| Цикл A → B → A | E_DESIGN_CYCLE зі шляхом |
| Uses у межах одного модуля | Не створює міжмодульний цикл |
| MDX без бізнес-прози | W_BUSINESS_CONTEXT_MISSING; headings самі по собі не достатні |
| Source TS або MDX із top-level side effect | CLI читає/parses, але не виконує його |
| Повторний запуск | Однакові JSON/Mermaid без random/time fields |
| Windows-style input paths | Нормалізовані report paths та locations |
| Review source з backticks | Коректні fences без втрати коду |
| Structural errors при inspect/review | complete:false і diagnostics |
| Review/graph/check/extract --check | Не змінюють файли й не роблять network calls |
| Extract | Пише лише власні generated outputs; MDX, implementations і tests незмінні |

Unit tests MDX extraction/mapping, parser/resolution; integration fixtures із реальним TS compiler; subprocess smoke для exit codes/stdout та встановленого tarball. Не обмежуватися mocks compiler або snapshots довгого output: перевіряти потрібні diagnostics/locations.

Показовий regression: прибрати `await` перед `Quota.take` у SendService. Поведінковий тест `quota` має ловити ранній виклик Sender. Харнес не зобов’язаний розуміти інваріант; compiler може окремо діагностувати частину таких помилок. Джерела сигналу не змішувати.

## 16. Поза MVP

- Skills bootstrap/plan/verify, інсталятори skills, автоматичне редагування repo-інструкцій.
- VS Code, web UI, MCP server, daemon/watch, cloud service.
- LLM API calls, credentials, model routing, token billing.
- Власний runner, JUnit/TAP ingestion, test run status, retry/flaky/skip policy.
- Доказ інваріантів, assertion parser, mutation testing engine, automatic test generation.
- Генерація/виправлення виконуваної бізнес-логіки. Виділення type-only generated TS із MDX входить у MVP.
- Locks, Git/base branch comparison, baseline hashes.
- Namespaces, stable @name, contract versioning, automatic rename migration.
- Інші мови/JS/TSX, кілька adapters, project references orchestration.
- Generic/inherited/overloaded contracts, barrel designs, module implementations.
- ORM/DB schemas, migrations, Zod runtime validation, OpenAPI codegen.
- Повний runtime dependency контроль, DI, точний call graph.
- Public plugin SDK, persisted index/cache, база даних. Generated TS є build artifact, не кешем registry.
- MDX rendering, React/JSX runtime, interactive components, live editor generation, language-service plugin.
- Довільні extraction outputs, автоматичне видалення orphan outputs, підтримка старого design.ts як другого source формату.

Можливі наступні кроки після перевірки корисності: adapter runner реального цільового репозиторію; external DTO imports; split design files; suites → конкретні implementations; impact query; baseline diff. Пріоритет задає реальне використання.

## 17. Definition of Done

1. Зібраний CLI працює на Node 24 та перевіреній версії TypeScript; є dependencies/lockfile.
2. Повний MDX fixture дає 3 generated modules, 1 DTO type, 3 contracts, 8 invariants і 8 прив’язок з очікуваним warning.
3. Негативні fixtures дають конкретні стабільні diagnostics та exit codes.
4. Design-фаза й graph працюють до появи реалізацій/тестів/фізичних generated TS через свіжий overlay.
5. Native implements не потрібен; instance/function/const перевіряються коректно.
6. Inspect/graph/review використовують єдиний індекс і не перебільшують гарантій.
7. Команди не виконують MDX/user source/test code і не підміняють test environment. Лише extract записує керовані generated outputs; решта read-only.
8. JSON має schemaVersion:1; output детермінований і придатний для агента.
9. README: setup, MDX/ts design, усі 8 directives, config, imports, extraction/freshness, supported subsets, limitations, authoring та CI workflow.
10. Mapping Unicode/CRLF/multiple blocks, stale outputs, conflicts і cross-module imports без фізичних outputs перевірені fixtures.
11. Виконані tests інструмента, build та smoke встановленого tarball. Публікація npm не потрібна і не виконується автоматично.

Підсумковий звіт LLM-розробника: реалізовані команди, фактичні результати перевірок, версії Node/TypeScript, обмеження, відхилення від специфікації й команди запуску. Не називати невиконану перевірку успішною.

## 18. Первинні джерела

Документ задає наш протокол; джерела пояснюють можливості інструментів і практики опису поведінки. TypeScript/BDD джерела перевірено 2026-09-29; MDX джерела — 2026-09-30.

1. [TypeScript: Type Compatibility](https://www.typescriptlang.org/docs/handbook/type-compatibility) — структурна сумісність.
2. [TypeScript: strictFunctionTypes](https://www.typescriptlang.org/tsconfig/strictFunctionTypes.html) — обмеження перевірки параметрів methods.
3. [Microsoft: Using the Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) — AST, Program, TypeChecker; API перевіряється на зафіксованій версії пакета.
4. [Node.js: Test runner](https://nodejs.org/api/test.html) — declarations та runtime можливості. Latest docs можуть містити новіше за Node 24; subset MVP перевіряється на Node 24.
5. [EARS: офіційний опис автора](https://alistairmavin.com/ears/) — структуровані речення вимог.
6. [Cucumber: Gherkin reference](https://cucumber.io/docs/gherkin/reference/) — правила та Given/When/Then.
7. [Cucumber: Example Mapping](https://cucumber.io/docs/bdd/example-mapping/) — правила, приклади, відкриті питання.
8. [Cucumber: Writing better Gherkin](https://cucumber.io/docs/bdd/better-gherkin/) — опис поведінки на відповідній межі.

Запозичення ідей не вимагає Cucumber, EARS parser чи стороннього SDD framework. Основа реалізації — TypeScript Compiler API, parser наших метаданих і статичний адаптер тестових декларацій.

9. [MDX Analyzer](https://github.com/mdx-js/mdx-analyzer) — MDX не підтримує TypeScript syntax безпосередньо; наші контракти живуть у code fences.
10. [mdast: Code](https://github.com/syntax-tree/mdast#code) — окремі поля lang/meta/value для code blocks.
11. [MDX: Using MDX](https://mdxjs.com/docs/using-mdx/) — MDX modules та межі автоматичної типізації exports; generated TS — наше рішення для звичайного compiler workflow.

`ts design`, generated-file lifecycle, ownership header і mapping diagnostics — правила нашого харнесу, не вбудована можливість MDX.

## 19. Перевірка прикладу під час оновлення документа

2026-09-30 із розділу 13 витягнуто 10 авторських файлів, зокрема 3 MDX-дизайни. Для перевірки прикладу тимчасовий скрипт виділив 4 буквальні `ts design` блоки та склав 3 generated TS за описаним правилом. Перевірено існування відносних file imports, 4 JSON-блоки документа та кількості: 3 contracts, 1 data type, 8 invariants, 8 `@covers`.

На Node.js v24.19.0 виконано два тестові файли: 8 tests, 8 passed, 0 failed. Реалізації та тестова поведінка збережені під час перенесення контрактів у MDX.

Це QA прикладу, не реалізація харнесу. Тимчасове виділення відомих literal fences не замінює повноцінний MDX AST parser. MDX compiler/parser, TypeScript typecheck, compiler overlay, source mapping та команди майбутнього CLI під час цього оновлення не виконувалися; їх потрібно реалізувати й перевірити за acceptance matrix. Очікувані звіти CLI у документі не є фактичними результатами готового продукту.
