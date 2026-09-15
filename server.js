const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "forum.json");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function initialData() {
  return {
    categories: [
      {
        id: 1,
        title: "Главный раздел",
        description: "Новости, объявления и общение сообщества",
        icon: "⌂",
        forums: [
          { id: 101, title: "Новости и информация", description: "Важные новости проекта и объявления администрации", threads: 12, posts: 84, last: "Администратор", time: "сегодня, 21:40" },
          { id: 102, title: "Общий раздел", description: "Общение участников форума", threads: 38, posts: 421, last: "PlayerOne", time: "сегодня, 20:17" }
        ]
      },
      {
        id: 2,
        title: "Игровой мир",
        description: "Разделы проекта и игровые обсуждения",
        icon: "◈",
        forums: [
          { id: 201, title: "Игровые новости", description: "Обновления, события и изменения", threads: 24, posts: 193, last: "NewsBot", time: "вчера, 19:05" },
          { id: 202, title: "Жалобы и обращения", description: "Обращения к администрации проекта", threads: 17, posts: 96, last: "Moderator", time: "вчера, 16:32" }
        ]
      }
    ],
    threads: [
      { id: 1, forumId: 101, title: "Добро пожаловать на форум", author: "Администратор", replies: 14, views: 824, time: "сегодня, 21:40", pinned: true },
      { id: 2, forumId: 102, title: "Правила сообщества", author: "Moderator", replies: 6, views: 311, time: "сегодня, 18:22", pinned: true },
      { id: 3, forumId: 102, title: "Ваши предложения по развитию проекта", author: "PlayerOne", replies: 27, views: 1205, time: "сегодня, 17:10", pinned: false }
    ],
    users: [
      { id: 1, name: "Администратор", role: "Администратор", level: 8, messages: 1248 },
      { id: 2, name: "Moderator", role: "Модератор", level: 5, messages: 642 },
      { id: 3, name: "PlayerOne", role: "Пользователь", level: 1, messages: 184 }
    ]
  };
}

function loadData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialData(), null, 2));
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return initialData(); }
}
function saveData(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get("/api/forum", (req, res) => {
  const data = loadData();
  res.json({
    categories: data.categories,
    threads: data.threads,
    users: data.users,
    stats: {
      users: data.users.length,
      threads: data.threads.length,
      posts: data.categories.reduce((a,c) => a + c.forums.reduce((x,f) => x + f.posts, 0), 0),
      online: Math.max(3, Math.min(99, data.users.length + 4))
    }
  });
});

app.get("/api/forum/thread/:id", (req, res) => {
  const data = loadData();
  const thread = data.threads.find(t => t.id === Number(req.params.id));
  if (!thread) return res.status(404).json({ error: "Тема не найдена" });
  res.json({
    thread,
    posts: [
      {
        id: 1,
        author: thread.author,
        role: thread.author === "Администратор" ? "Администратор" : "Пользователь",
        level: thread.author === "Администратор" ? 8 : 1,
        text: "Это демонстрационное сообщение. Здесь можно подключить полноценную базу данных и систему аккаунтов.",
        time: thread.time
      }
    ]
  });
});

app.post("/api/forum/thread", (req, res) => {
  const { forumId, title, author = "Гость" } = req.body;
  if (!forumId || !title || String(title).trim().length < 3) {
    return res.status(400).json({ error: "Укажите раздел и название темы" });
  }
  const data = loadData();
  const id = Math.max(0, ...data.threads.map(t => t.id)) + 1;
  const now = new Date().toLocaleString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  data.threads.unshift({ id, forumId: Number(forumId), title: String(title).trim(), author: String(author).trim() || "Гость", replies: 0, views: 0, time: `сегодня, ${now}`, pinned: false });
  saveData(data);
  res.status(201).json({ ok: true, id });
});

app.get("/api/user/:id", (req, res) => {
  const data = loadData();
  const user = data.users.find(u => u.id === Number(req.params.id));
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });
  res.json(user);
});

app.get("*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`[FORUM] Server started on port ${PORT}`));