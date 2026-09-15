const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) console.warn("[DB] DATABASE_URL is not set. Render/PostgreSQL is required for persistent data.");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
});

app.use(express.urlencoded({extended:true}));
app.use(express.json());

if (DATABASE_URL) {
  app.use(session({
    store: new pgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave:false,
    saveUninitialized:false,
    cookie:{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",maxAge:1000*60*60*24*14}
  }));
} else {
  app.use(session({secret:"local-dev",resave:false,saveUninitialized:false}));
}

const LEVELS = {
  1:"Пользователь",2:"Хелпер",3:"Младший модератор",4:"Модератор",
  5:"Старший модератор",6:"Администратор",7:"Старший администратор",8:"Владелец"
};

function esc(s=""){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
function redirect(res,url,msg){ if(msg) url += (url.includes("?")?"&":"?")+"msg="+encodeURIComponent(msg); return res.redirect(url); }
function user(req){return req.session.user||null}
function requireLogin(req,res,next){if(!user(req))return redirect(res,"/login","Сначала войдите в аккаунт");next()}
function requireLevel(level){return (req,res,next)=>{if(!user(req)||user(req).level<level)return res.status(403).send(page("Доступ запрещён",`<div class="empty"><h2>Недостаточно прав</h2><p>Требуется уровень ${level}.</p><a class="btn" href="/">На главную</a></div>`,req));next()}}
async function q(sql,params=[]){return (await pool.query(sql,params)).rows}

async function init(){
 if(!DATABASE_URL)return;
 await pool.query(`
 CREATE TABLE IF NOT EXISTS users(
   id SERIAL PRIMARY KEY, username VARCHAR(32) UNIQUE NOT NULL, password_hash TEXT NOT NULL,
   avatar TEXT DEFAULT '', level INT NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 8),
   bio TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS categories(id SERIAL PRIMARY KEY,title TEXT NOT NULL,description TEXT DEFAULT '',position INT DEFAULT 0);
 CREATE TABLE IF NOT EXISTS forums(id SERIAL PRIMARY KEY,category_id INT REFERENCES categories(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT DEFAULT '',position INT DEFAULT 0);
 CREATE TABLE IF NOT EXISTS threads(
   id SERIAL PRIMARY KEY,forum_id INT REFERENCES forums(id) ON DELETE CASCADE,user_id INT REFERENCES users(id) ON DELETE SET NULL,
   title TEXT NOT NULL, pinned BOOLEAN DEFAULT false, locked BOOLEAN DEFAULT false, views INT DEFAULT 0,
   created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS posts(
   id SERIAL PRIMARY KEY,thread_id INT REFERENCES threads(id) ON DELETE CASCADE,user_id INT REFERENCES users(id) ON DELETE SET NULL,
   body TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS notifications(
   id SERIAL PRIMARY KEY,user_id INT REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL,url TEXT DEFAULT '/',read BOOLEAN DEFAULT false,created_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE TABLE IF NOT EXISTS admin_logs(
   id SERIAL PRIMARY KEY,actor_id INT REFERENCES users(id) ON DELETE SET NULL,target_id INT REFERENCES users(id) ON DELETE SET NULL,
   action TEXT NOT NULL,details TEXT DEFAULT '',created_at TIMESTAMPTZ DEFAULT now()
 );
 CREATE INDEX IF NOT EXISTS threads_forum_idx ON threads(forum_id);
 CREATE INDEX IF NOT EXISTS posts_thread_idx ON posts(thread_id);
 `);
 const cats=await q("SELECT count(*)::int c FROM categories");
 if(cats[0].c===0){
   const c1=(await q("INSERT INTO categories(title,description,position) VALUES($1,$2,1) RETURNING id",["Главный раздел","Новости, объявления и общение сообщества"]))[0].id;
   const c2=(await q("INSERT INTO categories(title,description,position) VALUES($1,$2,2) RETURNING id",["Игровой мир","Игровые обсуждения и обращения"]))[0].id;
   await q("INSERT INTO forums(category_id,title,description,position) VALUES($1,$2,$3,1),($1,$4,$5,2)",[c1,"Новости и информация","Новости проекта и объявления","Общий раздел","Общение участников"]);
   await q("INSERT INTO forums(category_id,title,description,position) VALUES($1,$2,$3,1),($1,$4,$5,2)",[c2,"Игровые новости","Обновления и события","Жалобы и обращения","Обращения к администрации"]);
 }
 const admin=await q("SELECT id FROM users WHERE level=8 ORDER BY id LIMIT 1");
 if(admin.length===0 && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD){
   const hash=await bcrypt.hash(process.env.ADMIN_PASSWORD,12);
   await q("INSERT INTO users(username,password_hash,level) VALUES($1,$2,8)",[process.env.ADMIN_USERNAME,hash]);
   console.log("[AUTH] First level-8 administrator created");
 }
}
async function hydrate(req){
 if(req.session.user?.id){
   const rows=await q("SELECT id,username,avatar,level,bio,created_at FROM users WHERE id=$1",[req.session.user.id]);
   if(rows[0]){req.session.user=rows[0]; await q("UPDATE users SET last_seen=now() WHERE id=$1",[rows[0].id])}
 }
}

function layout(title,body,req){
 const u=user(req);
 const msg=req.query.msg?`<div class="notice">${esc(req.query.msg)}</div>`:"";
 const nav=u?`<a href="/members">Пользователи</a><a href="/profile/${u.id}">Профиль</a>${u.level>=6?`<a href="/admin">Админка</a>`:""}<a href="/logout">Выйти</a>`:`<a href="/members">Пользователи</a><a href="/login">Войти</a><a class="btn small" href="/register">Регистрация</a>`;
 return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#090c11"><title>${esc(title)} — SWAGFORUM</title><style>${CSS}</style></head><body>
 <header><div class="wrap bar"><button class="hamb" onclick="document.body.classList.toggle('navopen')">☰</button><a class="logo" href="/"><b>S</b> SWAG<span>FORUM</span></a><nav>${nav}</nav></div></header>
 <main class="wrap">${msg}${body}</main><footer><div class="wrap">SWAGFORUM · ${new Date().getFullYear()}</div></footer>
 </body></html>`;
}
function page(title,body,req){return layout(title,body,req)}

const CSS=`
:root{--bg:#090c11;--panel:#10151d;--panel2:#141a23;--line:#242c38;--text:#eef2f7;--muted:#8d98a8;--a:#f5a623}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,Segoe UI,Roboto,Arial}body:before{content:"";position:fixed;inset:-30%;z-index:-1;background:radial-gradient(circle at 50% 0,rgba(245,166,35,.12),transparent 35%)}a{color:inherit}.wrap{width:min(1180px,calc(100% - 24px));margin:auto}header{height:70px;position:sticky;top:0;z-index:10;background:#090c11ed;border-bottom:1px solid var(--line);backdrop-filter:blur(15px)}.bar{height:100%;display:flex;align-items:center;gap:28px}.logo{text-decoration:none;font-size:19px;font-weight:900;display:flex;align-items:center;gap:9px}.logo b{display:grid;place-items:center;width:35px;height:35px;border-radius:10px;background:var(--a);color:#111}.logo span{color:#778291;margin-left:3px}nav{display:flex;gap:20px;flex:1;align-items:center}nav a{text-decoration:none;color:#aeb7c4}nav a:hover{color:#fff}.hamb{display:none;background:#111720;border:1px solid var(--line);color:#fff;border-radius:8px;width:40px;height:40px}.hero{margin:34px 0;padding:42px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(135deg,#161c25,#0d1118)}.eyebrow{color:var(--a);font-size:11px;font-weight:900;letter-spacing:2px}.hero h1{font-size:clamp(35px,6vw,60px);line-height:1;margin:10px 0}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:minmax(0,1fr) 285px;gap:22px}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:15px}.cat{overflow:hidden;padding:0}.cat h3{margin:0;padding:18px;border-bottom:1px solid var(--line)}.forum{display:grid;grid-template-columns:1fr 80px 80px 150px;gap:10px;padding:16px 18px;border-bottom:1px solid var(--line);text-decoration:none}.forum:last-child{border:0}.forum:hover{background:#141a22}.forum small,.last small{display:block;color:var(--muted)}.count{text-align:center}.last{text-align:right}.btn{display:inline-block;text-decoration:none;background:var(--a);color:#111;border:0;border-radius:9px;padding:10px 16px;font-weight:800;cursor:pointer}.btn.dark{background:#111720;color:#ddd;border:1px solid var(--line)}.btn.danger{background:#b93d3d;color:#fff}.small{padding:7px 11px;font-size:13px}.actions{display:flex;gap:9px;flex-wrap:wrap;margin-top:18px}.notice{margin:20px 0;padding:12px 15px;border:1px solid #6b5425;background:#17140e;border-radius:10px;color:#f7d28c}.form{max-width:520px;margin:40px auto}.form input,.form textarea,.form select{width:100%;padding:12px;background:#0b1016;border:1px solid var(--line);border-radius:9px;color:#fff;margin:6px 0 14px;outline:0}.form textarea{min-height:150px;resize:vertical}.post{display:grid;grid-template-columns:155px 1fr;border:1px solid var(--line);background:var(--panel);margin-bottom:12px;border-radius:13px;overflow:hidden}.author{padding:18px;background:#0d1219;border-right:1px solid var(--line)}.avatar{width:65px;height:65px;border-radius:50%;object-fit:cover;background:#252d38;display:grid;place-items:center;font-weight:900;font-size:22px;margin-bottom:9px}.postbody{padding:20px}.postbody time{color:var(--muted);font-size:12px}.threadhead{display:flex;justify-content:space-between;gap:15px;align-items:start}.threadhead h1{margin:0;font-size:30px}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:12px;border-bottom:1px solid var(--line);text-align:left}.badge{display:inline-block;border:1px solid #5b6573;border-radius:999px;padding:2px 7px;font-size:11px;color:#cbd3dd}.level8{border-color:#e0a12e;color:#f5c260}.empty{text-align:center;padding:50px;color:var(--muted)}footer{border-top:1px solid var(--line);margin-top:45px;padding:25px 0;color:var(--muted);font-size:12px}
@media(max-width:800px){.wrap{width:calc(100% - 16px)}.hamb{display:block}nav{display:none;position:absolute;top:70px;left:0;right:0;background:#0c1118;border-bottom:1px solid var(--line);padding:10px}.navopen nav{display:grid}.hero{padding:28px 20px}.grid{grid-template-columns:1fr}.forum{grid-template-columns:1fr}.forum .count,.forum .last{display:none}.post{grid-template-columns:1fr}.author{border-right:0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center}.avatar{margin:0;width:48px;height:48px}.threadhead{display:block}.logo{flex:1}}
`;

app.get("/",async(req,res)=>{
 await hydrate(req);
 if(!DATABASE_URL)return res.send(page("Форум",`<section class="hero"><div class="eyebrow">SETUP</div><h1>SWAGFORUM</h1><p class="muted">Подключите PostgreSQL через DATABASE_URL, чтобы включить аккаунты и данные.</p></section>`,req));
 const cats=await q("SELECT * FROM categories ORDER BY position,id");
 const forums=await q(`SELECT f.*,c.title category FROM forums f JOIN categories c ON c.id=f.category_id ORDER BY c.position,f.position,f.id`);
 let content=`<section class="hero"><div class="eyebrow">COMMUNITY • ROLEPLAY • NEWS</div><h1>Форум сообщества</h1><p class="muted">Новости проекта, общение игроков и полезная информация — всё в одном месте.</p><div class="actions"><a class="btn" href="#forum">Перейти на форум</a><a class="btn dark" href="/new-thread">Создать тему</a></div></section><div class="grid"><section id="forum">`;
 for(const c of cats){
   content+=`<div class="card cat"><h3>◈ &nbsp;${esc(c.title)}<small class="muted">${esc(c.description)}</small></h3>`;
   for(const f of forums.filter(x=>x.category_id===c.id)){
     const s=await q(`SELECT count(*)::int c FROM threads WHERE forum_id=$1`,[f.id]);
     const p=await q(`SELECT count(*)::int c FROM posts p JOIN threads t ON t.id=p.thread_id WHERE t.forum_id=$1`,[f.id]);
     const last=await q(`SELECT u.username,t.updated_at FROM threads t LEFT JOIN users u ON u.id=t.user_id WHERE t.forum_id=$1 ORDER BY t.updated_at DESC LIMIT 1`,[f.id]);
     content+=`<a class="forum" href="/forum/${f.id}"><div><b>${esc(f.title)}</b><small>${esc(f.description)}</small></div><div class="count">${s[0].c}<small>тем</small></div><div class="count">${p[0].c}<small>постов</small></div><div class="last"><b>${esc(last[0]?.username||"—")}</b><small>${last[0]?new Date(last[0].updated_at).toLocaleString("ru-RU"):"нет тем"}</small></div></a>`;
   }
   content+="</div>";
 }
 const stats=await q("SELECT (SELECT count(*) FROM users)::int users,(SELECT count(*) FROM threads)::int threads,(SELECT count(*) FROM posts)::int posts,(SELECT count(*) FROM users WHERE last_seen>now()-interval '5 minutes')::int online");
 content+=`</section><aside><div class="card"><h3>Статистика</h3><div class="grid" style="grid-template-columns:1fr 1fr 1fr;gap:5px"><div><b>${stats[0].users}</b><small class="muted"> пользователей</small></div><div><b>${stats[0].threads}</b><small class="muted"> тем</small></div><div><b>${stats[0].posts}</b><small class="muted"> постов</small></div></div></div><div class="card"><h3>Сейчас онлайн</h3><b style="font-size:32px">${stats[0].online}</b> <span class="muted">участников</span></div></aside></div>`;
 res.send(page("Форум",content,req));
});

app.get("/register",(req,res)=>res.send(page("Регистрация",`<div class="form card"><h1>Регистрация</h1><p class="muted">Создайте аккаунт сообщества.</p><form method="post"><label>Логин</label><input name="username" minlength="3" maxlength="32" required><label>Пароль</label><input name="password" type="password" minlength="6" required><button class="btn">Создать аккаунт</button></form></div>`,req)));
app.post("/register",async(req,res)=>{
 if(!DATABASE_URL)return res.status(503).send("DATABASE_URL required");
 const username=String(req.body.username||"").trim(),password=String(req.body.password||"");
 if(username.length<3||password.length<6)return redirect(res,"/register","Логин от 3 символов, пароль от 6");
 if(!/^[a-zA-Zа-яА-Я0-9_]+$/.test(username))return redirect(res,"/register","Используйте только буквы, цифры и _");
 const exists=await q("SELECT id FROM users WHERE lower(username)=lower($1)",[username]);
 if(exists.length)return redirect(res,"/register","Такой логин уже занят");
 const hash=await bcrypt.hash(password,12),u=(await q("INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id,username,avatar,level,bio,created_at",[username,hash]))[0];
 req.session.user=u;res.redirect("/");
});
app.get("/login",(req,res)=>res.send(page("Вход",`<div class="form card"><h1>Вход</h1><form method="post"><label>Логин</label><input name="username" required><label>Пароль</label><input name="password" type="password" required><button class="btn">Войти</button></form><p class="muted">Нет аккаунта? <a href="/register">Регистрация</a></p></div>`,req)));
app.post("/login",async(req,res)=>{
 const rows=await q("SELECT * FROM users WHERE lower(username)=lower($1)",[String(req.body.username||"").trim()]);
 if(!rows[0]||!(await bcrypt.compare(String(req.body.password||""),rows[0].password_hash)))return redirect(res,"/login","Неверный логин или пароль");
 const u=rows[0];delete u.password_hash;req.session.user=u;await q("UPDATE users SET last_seen=now() WHERE id=$1",[u.id]);res.redirect("/");
});
app.get("/logout",(req,res)=>req.session.destroy(()=>res.redirect("/")));

app.get("/members",async(req,res)=>{
 const term=String(req.query.q||"").trim();
 const rows=await q("SELECT id,username,avatar,level,bio,created_at FROM users WHERE username ILIKE $1 ORDER BY level DESC,username LIMIT 100",[term?`%${term}%`:"%"]);
 let body=`<div class="hero"><div class="eyebrow">COMMUNITY</div><h1>Пользователи</h1><form method="get"><input name="q" value="${esc(term)}" placeholder="Поиск пользователя" style="padding:11px;background:#0b1016;border:1px solid var(--line);color:#fff;border-radius:9px;max-width:400px"><button class="btn">Поиск</button></form></div><div class="card"><table class="table"><tr><th>Пользователь</th><th>Группа</th><th>Регистрация</th></tr>`;
 for(const u of rows)body+=`<tr><td><a href="/profile/${u.id}"><b>${esc(u.username)}</b></a></td><td><span class="badge ${u.level===8?"level8":""}">Ур. ${u.level} · ${LEVELS[u.level]}</span></td><td>${new Date(u.created_at).toLocaleDateString("ru-RU")}</td></tr>`;
 body+="</table></div>";res.send(page("Пользователи",body,req));
});

app.get("/profile/:id",async(req,res)=>{
 const rows=await q("SELECT id,username,avatar,level,bio,created_at FROM users WHERE id=$1",[req.params.id]);if(!rows[0])return res.status(404).send(page("404",`<div class="empty">Пользователь не найден</div>`,req));
 const u=rows[0],can=user(req)?.id===u.id||user(req)?.level>=8;
 const posts=await q("SELECT count(*)::int c FROM posts WHERE user_id=$1",[u.id]);
 const avatar=u.avatar?`<img class="avatar" src="${esc(u.avatar)}" onerror="this.style.display='none'">`:`<div class="avatar">${esc(u.username[0].toUpperCase())}</div>`;
 let body=`<div class="card" style="margin-top:35px"><div style="display:flex;gap:18px;align-items:center">${avatar}<div><h1 style="margin:0">${esc(u.username)}</h1><span class="badge ${u.level===8?"level8":""}">Уровень ${u.level} · ${LEVELS[u.level]}</span><p class="muted">Сообщений: ${posts[0].c} · Регистрация: ${new Date(u.created_at).toLocaleDateString("ru-RU")}</p></div></div><hr style="border-color:var(--line);margin:20px 0"><p>${esc(u.bio||"Пользователь пока не добавил информацию о себе.")}</p>${can?`<a class="btn" href="/profile/${u.id}/edit">Изменить профиль</a>`:""}</div>`;
 res.send(page(u.username,body,req));
});
app.get("/profile/:id/edit",requireLogin,async(req,res)=>{
 const id=Number(req.params.id),u=user(req);if(u.id!==id&&u.level<8)return res.status(403).send(page("403","<div class='empty'>Недостаточно прав</div>",req));
 const rows=await q("SELECT * FROM users WHERE id=$1",[id]);if(!rows[0])return res.status(404).send("Not found");const x=rows[0];
 res.send(page("Редактирование",`<div class="form card"><h1>Профиль ${esc(x.username)}</h1><form method="post"><label>Аватар URL</label><input name="avatar" value="${esc(x.avatar||"")}"><label>О себе</label><textarea name="bio">${esc(x.bio||"")}</textarea>${u.level>=8?`<label>Уровень</label><select name="level">${Object.keys(LEVELS).map(l=>`<option value="${l}" ${x.level==l?"selected":""}>${l} — ${LEVELS[l]}</option>`).join("")}</select>`:""}<button class="btn">Сохранить</button></form></div>`,req));
});
app.post("/profile/:id/edit",requireLogin,async(req,res)=>{
 const id=Number(req.params.id),u=user(req);if(u.id!==id&&u.level<8)return res.status(403).send("Forbidden");
 const old=(await q("SELECT * FROM users WHERE id=$1",[id]))[0];let level=old.level;if(u.level>=8&&req.body.level)level=Math.max(1,Math.min(8,Number(req.body.level)));
 await q("UPDATE users SET avatar=$1,bio=$2,level=$3 WHERE id=$4",[String(req.body.avatar||"").trim(),String(req.body.bio||"").slice(0,2000),level,id]);
 if(u.level>=8)await q("INSERT INTO admin_logs(actor_id,target_id,action,details) VALUES($1,$2,$3,$4)",[u.id,id,"Изменение профиля",`Уровень: ${old.level} → ${level}`]);
 if(u.id===id)req.session.user={...req.session.user,avatar:String(req.body.avatar||"").trim(),bio:String(req.body.bio||""),level};
 res.redirect(`/profile/${id}`);
});

app.get("/forum/:id",async(req,res)=>{
 const f=await q("SELECT f.*,c.title category FROM forums f JOIN categories c ON c.id=f.category_id WHERE f.id=$1",[req.params.id]);if(!f[0])return res.status(404).send("Not found");
 const ts=await q(`SELECT t.*,u.username, u.level,(SELECT count(*) FROM posts p WHERE p.thread_id=t.id)::int replies FROM threads t LEFT JOIN users u ON u.id=t.user_id WHERE t.forum_id=$1 ORDER BY t.pinned DESC,t.updated_at DESC`,[req.params.id]);
 let body=`<div class="hero"><div class="eyebrow">${esc(f[0].category)}</div><h1>${esc(f[0].title)}</h1><p class="muted">${esc(f[0].description)}</p><a class="btn" href="/new-thread?forum=${f[0].id}">Создать тему</a></div><div class="card">`;
 if(!ts.length)body+=`<div class="empty">В этом разделе пока нет тем.</div>`;
 for(const t of ts)body+=`<div style="padding:15px;border-bottom:1px solid var(--line)"><a href="/thread/${t.id}"><b>${t.pinned?"📌 ":""}${t.locked?"🔒 ":""}${esc(t.title)}</b></a><div class="muted">Автор: ${esc(t.username||"Удалён")} · Ответов: ${t.replies} · Просмотров: ${t.views}</div></div>`;
 body+="</div>";res.send(page(f[0].title,body,req));
});

app.get("/new-thread",requireLogin,async(req,res)=>{
 const fs=await q("SELECT id,title FROM forums ORDER BY category_id,position,id");
 res.send(page("Новая тема",`<div class="form card"><h1>Создать тему</h1><form method="post"><label>Раздел</label><select name="forum_id">${fs.map(f=>`<option value="${f.id}" ${req.query.forum==f.id?"selected":""}>${esc(f.title)}</option>`).join("")}</select><label>Название</label><input name="title" maxlength="120" required><label>Сообщение</label><textarea name="body" maxlength="10000" required></textarea><button class="btn">Опубликовать</button></form></div>`,req));
});
app.post("/new-thread",requireLogin,async(req,res)=>{
 const title=String(req.body.title||"").trim(),body=String(req.body.body||"").trim(),fid=Number(req.body.forum_id);
 if(title.length<3||body.length<1)return redirect(res,"/new-thread","Заполните все поля");
 const f=await q("SELECT id FROM forums WHERE id=$1",[fid]);if(!f[0])return redirect(res,"/","Раздел не найден");
 const t=(await q("INSERT INTO threads(forum_id,user_id,title) VALUES($1,$2,$3) RETURNING id",[fid,user(req).id,title]))[0];
 await q("INSERT INTO posts(thread_id,user_id,body) VALUES($1,$2,$3)",[t.id,user(req).id,body]);res.redirect("/thread/"+t.id);
});

app.get("/thread/:id",async(req,res)=>{
 const t=await q(`SELECT t.*,f.title forum,u.username,u.level,u.avatar FROM threads t JOIN forums f ON f.id=t.forum_id LEFT JOIN users u ON u.id=t.user_id WHERE t.id=$1`,[req.params.id]);if(!t[0])return res.status(404).send("Not found");
 await q("UPDATE threads SET views=views+1 WHERE id=$1",[req.params.id]);
 const posts=await q(`SELECT p.*,u.username,u.level,u.avatar FROM posts p LEFT JOIN users u ON u.id=p.user_id WHERE p.thread_id=$1 ORDER BY p.id`,[req.params.id]);
 let body=`<div class="card" style="margin-top:30px"><div class="threadhead"><div><div class="eyebrow">${esc(t[0].forum)}</div><h1>${esc(t[0].title)}</h1></div>${t[0].locked?`<span class="badge">🔒 Закрыта</span>`:""}</div><div class="muted">${t[0].views} просмотров</div></div>`;
 for(const p of posts){const av=p.avatar?`<img class="avatar" src="${esc(p.avatar)}">`:`<div class="avatar">${esc((p.username||"?")[0].toUpperCase())}</div>`;body+=`<article class="post"><div class="author">${av}<div><a href="/profile/${p.user_id}"><b>${esc(p.username||"Удалён")}</b></a><br><span class="badge ${p.level===8?"level8":""}">ур. ${p.level||1}</span></div></div><div class="postbody"><time>${new Date(p.created_at).toLocaleString("ru-RU")}</time><p>${esc(p.body).replace(/\n/g,"<br>")}</p></div></article>`}
 if(user(req)&&!t[0].locked)body+=`<div class="form card"><h2>Ответить</h2><form method="post" action="/thread/${t[0].id}/reply"><textarea name="body" maxlength="10000" required></textarea><button class="btn">Отправить</button></form></div>`;
 if(user(req)?.level>=6)body+=`<div class="card actions"><form method="post" action="/thread/${t[0].id}/moderate"><button class="btn dark" name="action" value="${t[0].pinned?"unpin":"pin"}">${t[0].pinned?"Открепить":"Закрепить"}</button><button class="btn dark" name="action" value="${t[0].locked?"unlock":"lock"}">${t[0].locked?"Открыть":"Закрыть"}</button><button class="btn danger" name="action" value="delete" onclick="return confirm('Удалить тему?')">Удалить</button></form></div>`;
 res.send(page(t[0].title,body,req));
});
app.post("/thread/:id/reply",requireLogin,async(req,res)=>{
 const t=await q("SELECT * FROM threads WHERE id=$1",[req.params.id]);if(!t[0]||t[0].locked)return redirect(res,"/thread/"+req.params.id,"Тема закрыта");
 const body=String(req.body.body||"").trim();if(!body)return redirect(res,"/thread/"+req.params.id,"Пустое сообщение");
 await q("INSERT INTO posts(thread_id,user_id,body) VALUES($1,$2,$3)",[req.params.id,user(req).id,body]);await q("UPDATE threads SET updated_at=now() WHERE id=$1",[req.params.id]);res.redirect("/thread/"+req.params.id);
});
app.post("/thread/:id/moderate",requireLevel(6),async(req,res)=>{
 const action=req.body.action,id=Number(req.params.id),actor=user(req);
 if(action==="delete"){await q("DELETE FROM threads WHERE id=$1",[id]);await q("INSERT INTO admin_logs(actor_id,action,details) VALUES($1,$2,$3)",[actor.id,"Удаление темы",`thread=${id}`]);return res.redirect("/")}
 if(["pin","unpin","lock","unlock"].includes(action)){const field=action==="pin"||action==="unpin"?"pinned":"locked";const value=action==="pin"||action==="lock";await q(`UPDATE threads SET ${field}=$1 WHERE id=$2`,[value,id]);await q("INSERT INTO admin_logs(actor_id,action,details) VALUES($1,$2,$3)",[actor.id,"Модерация темы",`${field}=${value}, thread=${id}`])}
 res.redirect("/thread/"+id);
});

app.get("/admin",requireLevel(6),async(req,res)=>{
 const stats=(await q("SELECT (SELECT count(*) FROM users)::int users,(SELECT count(*) FROM threads)::int threads,(SELECT count(*) FROM posts)::int posts"))[0];
 const users=await q("SELECT id,username,level,created_at FROM users ORDER BY level DESC,username LIMIT 100");
 const logs=await q("SELECT l.*,a.username actor,t.username target FROM admin_logs l LEFT JOIN users a ON a.id=l.actor_id LEFT JOIN users t ON t.id=l.target_id ORDER BY l.id DESC LIMIT 50");
 let body=`<div class="hero"><div class="eyebrow">CONTROL PANEL</div><h1>Админ-панель</h1><p class="muted">Управление пользователями и журнал действий.</p></div><div class="card"><h2>Статистика</h2><p>Пользователи: <b>${stats.users}</b> · Темы: <b>${stats.threads}</b> · Сообщения: <b>${stats.posts}</b></p></div><div class="card"><h2>Пользователи</h2><table class="table"><tr><th>Логин</th><th>Уровень</th><th>Действие</th></tr>`;
 for(const x of users)body+=`<tr><td><a href="/profile/${x.id}">${esc(x.username)}</a></td><td>${x.level} — ${LEVELS[x.level]}</td><td><a class="btn small dark" href="/profile/${x.id}/edit">Изменить</a></td></tr>`;
 body+=`</table></div><div class="card"><h2>Журнал изменений</h2>`;
 for(const l of logs)body+=`<div style="padding:10px 0;border-bottom:1px solid var(--line)"><b>${esc(l.action)}</b> — ${esc(l.actor||"system")} ${l.target?`→ ${esc(l.target)}`:""}<div class="muted">${esc(l.details)} · ${new Date(l.created_at).toLocaleString("ru-RU")}</div></div>`;
 body+="</div>";res.send(page("Админ-панель",body,req));
});

app.get("/health",async(req,res)=>{try{if(DATABASE_URL)await q("SELECT 1");res.json({ok:true,db:Boolean(DATABASE_URL)})}catch(e){res.status(500).json({ok:false,error:e.message})}});

init().then(()=>app.listen(PORT,()=>console.log(`[FORUM] Running on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
