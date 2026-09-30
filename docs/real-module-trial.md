# Перевірка на реальному модулі

Дата: 30.09.2026. Проєкт: `content-library`, застосунок `apps/content-library-api` (NestJS 11, Drizzle, Vitest 4, TypeScript 5.9.2). Модуль: `src/modules/accounts` — два сервіси (`AccountsService`, `AccountMembershipsService`), 197 рядків коду, 16 тестів.

Мета кроку з плану: взяти модуль з існуючими реалізацією та тестами, описати його контракт і подивитися, скільки анотацій потрібно, які помилки харнес знаходить і чи зрозумілі повідомлення.

## Що зроблено в проєкті

Усе лишилося в робочому дереві `content-library` незакоміченим.

| Файл | Зміна |
| --- | --- |
| `.design/config.json` | новий, 5 рядків: шаблон тестів `src/**/*.spec.ts`, адаптер `vitest` |
| `src/modules/accounts/.design/design.mdx` | новий, 172 рядки: проза, 5 типів даних, 2 контракти, 16 інваріантів, відкриті питання |
| `src/modules/accounts/.design/design.generated.ts` | згенерований `design extract`, 135 рядків |
| `accounts.service.ts`, `account-memberships.service.ts` | по одному рядку `/** @implements … */` |
| `accounts.service.spec.ts`, `account-memberships.service.spec.ts` | 2 рядки `@tests` і 16 рядків `@covers` |

Разом у наявному коді додано 20 рядків-коментарів у 4 файлах. Жодного рядка коду не змінено.

Результат:

```
check: 1 design, 2 contracts, 5 data types, 16 invariants, 2 implementations, 16 test declarations,
  16 of 16 invariants linked to a test declaration; 0 errors, 0 warnings. TypeScript 5.9.2 (project).
```

Повна перевірка застосунку триває близько 1,4 с.

## Що спрацювало без жодних налаштувань

- Харнес узяв TypeScript 5.9.2 самого проєкту; `baseUrl`, `paths`, `extends` зі спільного пакета конфігів і декоратори NestJS проблем не створили.
- Класи з `@Injectable()` порівнюються з контрактом як звичайні класи.
- Типи, які Drizzle виводить зі схеми, і DTO з `z.infer` структурно збіглися з типами, написаними в дизайні вручну.
- Тести з `import { describe, it } from "vitest"` розпізналися; вкладені `describe` за методами успадкували контракт від верхнього.
- ESLint проєкту на модулі проходить. Prettier проходить після того, як `design.mdx` відформатовано Prettier-ом проєкту: згенерований файл повторює форматування блоків.

## Які помилки харнес знаходить

У модулі як він є — жодної: реалізація й тести узгоджені з контрактом, який я з них і виводив. Користь видно на змінах. Три навмисні правки контракту:

| Правка в `design.mdx` | Що сказав `design check` |
| --- | --- |
| `Account.slug` став обов’язковим рядком | `E_TYPE_MISMATCH`: «Types of property 'slug' are incompatible … Type 'null' is not assignable to type 'string'» |
| Додано метод `restore` | `E_TYPE_MISMATCH`: «Property 'restore' is missing in type 'AccountsService'», з посиланням на рядок методу в MDX; плюс `E_TEST_MISSING` для його інваріанта |
| `findById(id: number, …)` | `E_TYPE_MISMATCH`: «Types of parameters 'id' and 'id' are incompatible» |

Так само до запуску `extract` і розставлення тегів `check` видав список із 19 пунктів: немає generated-файла, два контракти без реалізації, 16 інваріантів без тесту. Це працює як перелік того, що лишилося зробити.

## Чи зрозумілі повідомлення

- Про відсутні реалізації й тести — так, із точним рядком інваріанта в MDX.
- Про невідповідність типів — точні, але довгі. Для типів, виведених ORM, компілятор друкує весь об’єктний тип на кожному рівні пояснення: у прикладі зі `slug` це сім рядків, з яких корисні перший і два останні. Це робота для етапу «Вивід».
- Тег між декоратором і класом (`@Injectable()` → `/** @implements */` → `export class`) дає `E_TAG_LOCATION`. Повідомлення тепер прямо каже, що тег стоїть над декораторами.

## Що заважало

1. **Generated-файл тут нікому не потрібен.** Сервіси не імпортують типи контрактів, а `tsc` проєкту цей файл не бачить: `include: ["src/**/*"]` не заходить у dot-каталоги. Проте `design check` вимагає, щоб файл існував і був актуальний, тобто після кожної правки контракту треба запускати `extract` заради файла без читачів. Вирішено: поле `"generatedFiles": false` у конфігурації (пункт 12 у `plan-proposals.md`). У цьому проєкті його ввімкнено, три generated-файли видалено, `design check` дає той самий результат.
2. **Типи доводиться переписувати.** 5 типів даних займають близько 50 зі 172 рядків дизайну й повторюють схему Drizzle та схеми zod. Імпортувати їх у дизайн план забороняє. Структурна перевірка тримає їх узгодженими в один бік: якщо контракт вимагає поля, якого схема не має, це помилка; нова колонка у схемі контракту не порушує.
3. **`db: Database` у кожному методі.** Тип з ORM у дизайні назвати не можна, тож у контракті це `DatabaseHandle = unknown`. Відповідність проходить лише завдяки тому, що TypeScript порівнює параметри методів біваріантно; про сам параметр контракт нічого не стверджує. Параметр інфраструктури в кожній сигнатурі — шум для читача контракту.
4. **Тести проєкту запустити не вдалося.** Vitest на цій машині падає на нативному модулі rollup: проєкт розрахований на devcontainer. Теги — це лише коментарі, але те, що 16 тестів після них проходять, я не перевірив.

## Чого не було видно на цьому модулі

- `@uses`: сервіси модуля не викликають контракти один одного, тег не знадобився.
- Тест без `describe`: тут усі тести в `describe`, обмеження не зачепило.
- Відповідність тестів і інваріантів була один до одного. Чи перевіряє тест саме те, що каже інваріант, харнес не знає; це завдання LLM-рев’ю з етапу «Вивід».

## Побічна користь

Щоб написати інваріанти, довелося словами сформулювати поведінку, яка була лише в назвах тестів і в одному коментарі: що робить повторний webhook (`replay`), що відбувається з членством після повторного додавання користувача (`relink`). З’явилися два відкриті питання до продукту, записані в кінці `design.mdx`: чи приймати членство у видаленому акаунті, і чому акаунти видаляються м’яко, а членства — остаточно.

## Друга частина: всі види декларацій

Модуль `accounts` використав лише класи-сервіси. Щоб перевірити решту можливостей на справжньому коді, додано ще два дизайни: `src/core/versioning` (чисті функції з `semver.ts` і `changelog-composer.ts`) та `src/modules/topics` (лише `topics.changelog.ts`).

```
check: 3 designs, 10 contracts, 7 data types, 34 invariants, 10 implementations, 28 test declarations,
  34 of 34 invariants linked to a test declaration; 0 errors, 0 warnings. TypeScript 5.9.2 (project).
```

Повна перевірка так само триває близько 1,4 с. ESLint, Prettier і `tsc --noEmit` проєкту проходять.

| Що перевірено | Де в проєкті | Результат |
| --- | --- | --- |
| Контракт із методами, реалізація — клас із декоратором | `AccountsService`, `AccountMembershipsService` | працює |
| Контракт з одним call signature, реалізація — функція | `parse`, `format`, `bumpMinor`, `bumpMajor`, `joinLines` | працює |
| Реалізація — `const` зі стрілковою функцією | `isBlank` | працює |
| Реалізація — `const` з об’єктом | `changelogText`, `topicsChangelogText` | працює |
| `@data` як `interface` і як `type` | `SemVer`, `Slot`, DTO акаунтів | працює |
| `@uses` у межах модуля | `BumpMinor` → `ParseVersion`, `FormatVersion` | працює |
| `@uses` між модулями | `TopicsChangelogText` → `IsBlank` | працює |
| Імпорт типу з іншого дизайну через alias `@/…` | `Slot` у дизайні topics | працює |
| Інваріант на рівні контракту й на рівні методу | `silent` і `thumbnail-added` | працює |
| `@tests` на вкладених `describe` | `semver.spec.ts`: свій контракт на кожен блок | працює |
| Один тест покриває кілька інваріантів; один інваріант має два тести | `topics.changelog.spec.ts`, `silent` | працює |
| Тег у наявному JSDoc-коментарі | функції `semver.ts` | працює |
| Цикл між модулями | навмисний `@uses TopicsChangelogText` у versioning | `E_DESIGN_CYCLE` зі шляхом |

Навмисні поломки на нових видах декларацій харнес теж упіймав: зміну сигнатури `FormatVersion` («Type 'string' is not assignable to type 'number'» у місці функції `format`) і метод, якого немає в об’єкті `topicsChangelogText`.

### Що заважало цього разу

1. **Один suite — один контракт.** У `changelog-composer.spec.ts` два тести двох різних функцій стояли в одному `describe`. `@tests` дозволяє suite лише один контракт, тож `@covers` другого тесту дав `E_REFERENCE_UNKNOWN`. Довелося змінити сам тест: кожній функції свій вкладений `describe`.
2. **Модуль функцій описується окремими контрактами.** «Модуль як реалізація» поза MVP, тому чотири функції `semver.ts` — це чотири контракти з одним викликом кожен. Контракт вийшов приблизно такого ж розміру, як код, який він описує.
3. **Знайдено справжню прогалину.** `isBlank` не мала власного тесту: вона перевірялась лише опосередковано через тести topics. `E_TEST_MISSING` на це вказав; я додав один тест із чотирма перевірками.

### Зміни в проєкті після другої частини

- три `design.mdx` (accounts, versioning, topics) і три згенеровані файли;
- теги в 6 файлах реалізацій і 5 файлах тестів: 10 `@implements`, 10 `@tests`, 28 `@covers`;
- `changelog-composer.spec.ts` перебудовано: три вкладені `describe` і новий тест для `isBlank`.

Це єдине місце, де змінено код, а не лише додано коментарі. Запустити Vitest на цій машині не вдалося, тож перебудований тест перевірено лише типами (`tsc --noEmit`).

## Третя частина: замки

Після додавання `@final` і `@extendable` у харнес їх перевірено на модулі `accounts`: контракт `Accounts` позначено `@final`, контракт `AccountMemberships` і тип `Account` — `@extendable`. `design lock` записав три декларації в `.design/design.lock.json`. Далі в дизайн додано метод до `Accounts` і поле до `Account`:

```
src/modules/accounts/.design/design.mdx:23:18: warning W_LOCK_UNRECORDED: Data type "Account" has additions that are not locked yet: `plan`. Run `design lock` to record them.
src/modules/accounts/.design/design.mdx:92:18: error E_LOCK_VIOLATION: Contract "Accounts" is `@final`: it must not change.
  `list` was added
```

Правки повернуто; теги й файл-замок лишилися в проєкті. Prettier проєкту файл-замок приймає.

Згодом замок розширено: він охоплює інваріанти контракту, а про відкриті типи всередині замкненої декларації харнес попереджає. На цьому модулі з’явилося п’ять попереджень `W_LOCK_OPEN_TYPE`: `Accounts` (`@final`) використовував `DatabaseHandle` і `AccountUpsert` без замка, `AccountMemberships` — `MembershipUpsert`, `DatabaseHandle` і `Membership`. Після позначення цих чотирьох типів файл-замок містить сім декларацій, із них два контракти з 7 і 9 інваріантами, і попереджень про замки немає.

## Четверта частина: що дизайн не покриває

Після додавання `W_NOT_DESIGNED` `design check` показав у трьох модулях із дизайном 71 exported декларацію без контракту: 47 у `core/versioning`, 12 в `accounts` і навколо, 12 у `topics`. У модулі `accounts` і `topics` додано `.design/ignore` з трьома рядками (`entities/`, `dto/`, `*.module.ts`): таблиці Drizzle, схеми zod і NestJS-модулі власної поведінки не мають. Після цього в цих двох модулях лишилося чотири попередження, і всі по суті:

```
src/modules/accounts/webhooks-accounts.controller.ts:17:14: warning W_NOT_DESIGNED: Exported class "WebhooksAccountsController" …
src/modules/topics/topics.asserts.ts:8:14: warning W_NOT_DESIGNED: Exported class "TopicsAsserts" …
src/modules/topics/topics.controller.ts:63:14: warning W_NOT_DESIGNED: Exported class "TopicsController" …
src/modules/topics/topics.service.ts:23:14: warning W_NOT_DESIGNED: Exported class "TopicsService" …
```

47 попереджень у `core/versioning` лишено: це справжній рушій версіонування, якого дизайн ще не описує.

## Висновки

- Ціна підключення модуля невелика: один документ і по рядку на реалізацію й тест. Основна праця — написати сам контракт.
- Механіка працює на реальному NestJS-коді без змін у конфігурації проєкту.
- Перед ширшим застосуванням варто вирішити три речі: як описувати інфраструктурні параметри на зразок `db`; чи дозволити дизайну посилатися на типи схеми замість переписування; чи дозволити одному suite тести кількох контрактів або `@tests` разом із `@covers` на самому тесті.

## Як прибрати зміни з проєкту

```sh
cd /Users/vitaliyshebela/Projects/content-library/apps/content-library-api
git checkout -- src/modules/accounts src/modules/topics src/core/versioning
rm -r .design src/modules/accounts/.design src/modules/topics/.design src/core/versioning/.design   # .design містить і файл-замок
```
