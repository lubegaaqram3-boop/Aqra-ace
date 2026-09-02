import express from "express";
import http from "http";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import { WebSocketServer } from "ws";

const { Pool } = pg;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_PRODUCTION";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL ? { rejectUnauthorized:false } : false });

app.use(express.json({ limit:"100kb" }));
app.use(express.static("public"));

async function init() {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL is not set. Create a PostgreSQL database before starting.");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      codename VARCHAR(24) UNIQUE NOT NULL,
      age INT NOT NULL CHECK (age BETWEEN 13 AND 20),
      class_name VARCHAR(30) NOT NULL,
      interests TEXT[] NOT NULL DEFAULT '{}',
      languages TEXT[] NOT NULL DEFAULT '{}',
      bio VARCHAR(160) NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS friendships (
      requester UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(12) NOT NULL CHECK(status IN ('pending','accepted','blocked')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(requester, addressee)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      sender UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body VARCHAR(1000) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
const publicUser = u => ({id:u.id, codename:u.codename, age:u.age, className:u.class_name, interests:u.interests, languages:u.languages, bio:u.bio});
function auth(req,res,next){
  try {
    const token=(req.headers.authorization||"").replace(/^Bearer /,"");
    req.user=jwt.verify(token,JWT_SECRET);
    next();
  } catch { res.status(401).json({error:"Authentication required"}); }
}
function tokenFor(id){ return jwt.sign({id},JWT_SECRET,{expiresIn:"7d"}); }

app.get("/api/health", (_,res)=>res.json({ok:true}));

app.post("/api/register", async (req,res)=>{
  try {
    const {codename,age,className,interests=[],languages=[],bio="",password}=req.body;
    if(!codename || !password || !Number.isInteger(+age) || +age<13 || +age>20)
      return res.status(400).json({error:"Use a valid codename, password and age 13–19."});
    if(!/^[A-Za-z0-9_-]{3,24}$/.test(codename))
      return res.status(400).json({error:"Codename must be 3–24 letters, numbers, _ or -."});
    const hash=await bcrypt.hash(password,12), id=crypto.randomUUID();
    const r=await pool.query(
      `INSERT INTO users(id,codename,age,class_name,interests,languages,bio,password_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id,codename,+age,className,String(interests).split(",").map(x=>x.trim()).filter(Boolean).slice(0,12),
       String(languages).split(",").map(x=>x.trim()).filter(Boolean).slice(0,8),String(bio).slice(0,160),hash]
    );
    res.json({token:tokenFor(id),user:publicUser(r.rows[0])});
  } catch(e) {
    if(e.code==="23505") return res.status(409).json({error:"That codename is already taken."});
    console.error(e); res.status(500).json({error:"Server error"});
  }
});

app.post("/api/login", async (req,res)=>{
  const r=await pool.query("SELECT * FROM users WHERE codename=$1",[req.body.codename||""]);
  if(!r.rowCount || !(await bcrypt.compare(req.body.password||"",r.rows[0].password_hash)))
    return res.status(401).json({error:"Invalid codename or password."});
  res.json({token:tokenFor(r.rows[0].id),user:publicUser(r.rows[0])});
});

app.get("/api/me",auth,async(req,res)=>{
  const r=await pool.query("SELECT * FROM users WHERE id=$1",[req.user.id]);
  if(!r.rowCount) return res.status(404).json({error:"User not found"});
  res.json(publicUser(r.rows[0]));
});

app.get("/api/discover",auth,async(req,res)=>{
  const me=(await pool.query("SELECT * FROM users WHERE id=$1",[req.user.id])).rows[0];
  const r=await pool.query(`
    SELECT u.id,u.codename,u.age,u.class_name,u.interests,u.languages,u.bio,
           COALESCE((SELECT COUNT(*) FROM unnest(u.interests) i WHERE i=ANY($2::text[])),0) AS common
    FROM users u
    WHERE u.id<>$1 AND u.age BETWEEN $3 AND $4
      AND NOT EXISTS (
        SELECT 1 FROM friendships f
        WHERE (f.requester=$1 AND f.addressee=u.id) OR (f.requester=u.id AND f.addressee=$1)
      )
    ORDER BY common DESC, u.created_at DESC LIMIT 50`,
    [req.user.id, me.interests, Math.max(13,me.age-2), Math.min(20,me.age+2)]
  );
  res.json(r.rows.map(x=>({...publicUser(x),common:+x.common})));
});

app.get("/api/friends",auth,async(req,res)=>{
  const r=await pool.query(`
    SELECT f.requester,f.addressee,f.status,u.id,u.codename,u.age,u.class_name,u.interests,u.languages,u.bio
    FROM friendships f
    JOIN users u ON u.id=CASE WHEN f.requester=$1 THEN f.addressee ELSE f.requester END
    WHERE (f.requester=$1 OR f.addressee=$1) AND f.status IN ('pending','accepted')
    ORDER BY f.created_at DESC`,[req.user.id]);
  res.json(r.rows.map(x=>({...publicUser(x),status:x.status,direction:x.requester===req.user.id?"outgoing":"incoming"})));
});

app.post("/api/friends/request/:id",auth,async(req,res)=>{
  if(req.params.id===req.user.id) return res.status(400).json({error:"You cannot add yourself."});
  try {
    await pool.query(`INSERT INTO friendships(requester,addressee,status) VALUES($1,$2,'pending')`,[req.user.id,req.params.id]);
    res.json({ok:true});
  } catch(e) { res.status(400).json({error:"Request already exists or user is unavailable."}); }
});

app.post("/api/friends/accept/:id",auth,async(req,res)=>{
  await pool.query(`UPDATE friendships SET status='accepted' WHERE requester=$1 AND addressee=$2`,[req.params.id,req.user.id]);
  res.json({ok:true});
});

app.post("/api/block/:id",auth,async(req,res)=>{
  await pool.query(`DELETE FROM friendships WHERE requester=$1 OR addressee=$1 AND (requester=$2 OR addressee=$2)`,[req.user.id,req.params.id]);
  await pool.query(`INSERT INTO friendships(requester,addressee,status) VALUES($1,$2,'blocked')
                    ON CONFLICT(requester,addressee) DO UPDATE SET status='blocked'`,[req.user.id,req.params.id]);
  res.json({ok:true});
});

app.post("/api/report/:id",auth,async(req,res)=>{
  console.log("REPORT", {reporter:req.user.id,target:req.params.id,reason:String(req.body.reason||"").slice(0,300)});
  res.json({ok:true,message:"Report received."});
});

app.get("/api/messages/:id",auth,async(req,res)=>{
  const ok=await pool.query(`SELECT 1 FROM friendships WHERE status='accepted'
    AND ((requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1))`,[req.user.id,req.params.id]);
  if(!ok.rowCount) return res.status(403).json({error:"Messaging requires mutual friendship."});
  const r=await pool.query(`SELECT id,sender,receiver,body,created_at FROM messages
    WHERE (sender=$1 AND receiver=$2) OR (sender=$2 AND receiver=$1)
    ORDER BY id ASC LIMIT 200`,[req.user.id,req.params.id]);
  res.json(r.rows);
});

const sockets=new Map();
wss.on("connection",(ws,req)=>{
  const url=new URL(req.url,"http://localhost");
  try {
    const user=jwt.verify(url.searchParams.get("token")||"",JWT_SECRET);
    sockets.set(user.id,ws);
    ws.on("close",()=>sockets.delete(user.id));
    ws.on("message",async raw=>{
      try {
        const {to,body}=JSON.parse(raw);
        if(!to || !body || body.length>1000) return;
        const ok=await pool.query(`SELECT 1 FROM friendships WHERE status='accepted'
          AND ((requester=$1 AND addressee=$2) OR (requester=$2 AND addressee=$1))`,[user.id,to]);
        if(!ok.rowCount) return ws.send(JSON.stringify({error:"Mutual friendship required."}));
        const r=await pool.query(`INSERT INTO messages(sender,receiver,body) VALUES($1,$2,$3) RETURNING *`,[user.id,to,body.trim()]);
        const msg=r.rows[0], payload=JSON.stringify({type:"message",message:msg});
        ws.send(payload); sockets.get(to)?.send(payload);
      } catch {}
    });
  } catch { ws.close(); }
});

init().catch(console.error);
server.listen(PORT,()=>console.log(`Aqra Ace listening on ${PORT}`));
