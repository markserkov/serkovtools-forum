# SWAGFORUM

Готовая стартовая версия современного игрового форума на Node.js + Express.

## Запуск локально

```bash
npm install
npm start
```

Открой `http://localhost:3000`.

## Render

1. Создай новый Web Service в Render.
2. Подключи GitHub-репозиторий.
3. Runtime: Node.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Render автоматически передаст `PORT`.

Проект не требует `.env` для запуска.

## Важно про хранение данных

Демо-версия хранит данные в `data/forum.json`. На бесплатном Render локальная файловая система не предназначена для постоянного хранения при пересоздании/деплое сервиса. Для настоящего форума подключи PostgreSQL (или другой постоянный datastore).

## Структура

- `server.js` — Express backend/API
- `public/index.html` — интерфейс
- `public/style.css` — дизайн
- `public/app.js` — клиентская логика
- `data/forum.json` — создаётся автоматически при первом запуске
