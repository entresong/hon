// ============================================================
// 魂 (혼) — 권위 게임 서버 (배포판)
// HTTP로 게임 화면(client.html)을 서빙하고, 같은 포트에서 WebSocket으로 세계를 돌린다.
// 실행: node server.js → 브라우저에서 http://localhost:8787 접속
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8787;
const TICK = 50;
const WORLD = 1600;
const PLAYER_SPEED = 170;
const ATTACK_CD = 600;
const MONSTER_COUNT = 24;
const SOUL_PRIORITY_MS = 5000;
const REGEN_HP = 2.4;
const REGEN_MP = 1.6;

// ---------- HTTP: 게임 화면 서빙 ----------
const httpServer = http.createServer((req, res) => {
  if(req.url === '/' || req.url === '/index.html'){
    fs.readFile(path.join(__dirname, 'client.html'), (err, data) => {
      if(err){ res.writeHead(500); res.end('client.html 없음'); return; }
      res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
      res.end(data);
    });
  } else { res.writeHead(404); res.end(); }
});

const players = new Map();
const monsters = new Map();
const souls = new Map();
let nextId = 1;
const nid = (p) => p + (nextId++);

function rnd(n){ return Math.random()*n; }
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }

function spawnMonster(){
  const x = 80 + rnd(WORLD-160), y = 80 + rnd(WORLD-160);
  const tier = 1 + Math.floor(rnd(3));
  monsters.set(nid('m'), {
    x, y, tier,
    hp: 20*tier, maxHp: 20*tier, atk: 3+tier*2,
    wander: rnd(Math.PI*2), aggroId: null,
    damage: new Map(), lastHitAt: 0,
  });
}
for(let i=0;i<MONSTER_COUNT;i++) spawnMonster();

// ---------- WebSocket: 같은 서버에 부착 ----------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const id = nid('p');
  ws.on('message', (raw) => {
    let m; try{ m = JSON.parse(raw); }catch(e){ return; }

    if(m.t === 'join'){
      const name = String(m.name||'무명천민').slice(0,10);
      players.set(id, { ws, name,
        x: 200+rnd(300), y: WORLD-300+rnd(200), tx:null, ty:null,
        hp: 60, maxHp: 60, mp: 30, maxMp: 30, atk: 7, range: 34,
        level: 1, exp: 0, soul: 0, lastAtk: 0, respawnAt: 0, attackId: null,
        lastDamagedAt: 0 });
      ws.send(JSON.stringify({ t:'welcome', id, world: WORLD }));
      return;
    }
    const p = players.get(id);
    if(!p || p.respawnAt > Date.now()) return;

    if(m.t === 'move'){
      p.tx = Math.max(20, Math.min(WORLD-20, +m.x||0));
      p.ty = Math.max(20, Math.min(WORLD-20, +m.y||0));
      p.attackId = null;
    }
    if(m.t === 'attack'){
      if(monsters.has(m.id)) { p.attackId = m.id; p.tx = p.ty = null; }
    }
    if(m.t === 'loot'){
      const s = souls.get(m.id);
      if(!s) return;
      const now = Date.now();
      const canLoot = (now >= s.unlockAt) || (s.ownerId === id);
      if(canLoot && dist(p, s) < 40){
        p.soul += s.amount;
        souls.delete(m.id);
        send(p.ws, { t:'msg', k:'g', text:`+${s.amount} 魂` });
      } else if(!canLoot && dist(p,s) < 40){
        send(p.ws, { t:'msg', k:'b', text:'아직 임자가 있는 혼이다 (5초 후 무주공산)' });
      }
    }
  });
  ws.on('close', () => players.delete(id));
});

function send(ws, obj){ try{ ws.send(JSON.stringify(obj)); }catch(e){} }
function broadcast(obj){ const s = JSON.stringify(obj); for(const p of players.values()) try{ p.ws.send(s); }catch(e){} }

function expNeed(level){ return level * 12; }
function grantExp(p, pid, n){
  p.exp += n;
  while(p.exp >= expNeed(p.level)){
    p.exp -= expNeed(p.level);
    p.level++;
    p.maxHp += 10;
    p.maxMp += 5;
    p.atk += 2;
    p.hp = p.maxHp;
    p.mp = p.maxMp;
    send(p.ws, { t:'msg', k:'g', text:`기량이 올랐다 — Lv ${p.level}` });
    broadcast({ t:'fx', kind:'levelup', id: pid, level: p.level });
  }
}

setInterval(() => {
  const now = Date.now();
  const dt = TICK/1000;

  for(const [pid, p] of players){
    if(p.respawnAt > now) continue;
    if(p.respawnAt && p.respawnAt <= now){
      p.respawnAt = 0; p.hp = p.maxHp; p.mp = p.maxMp;
      p.x = 200+rnd(300); p.y = WORLD-300+rnd(200);
    }
    const idle = !p.attackId && p.tx === null;
    const safeFromHits = now - p.lastDamagedAt > 3000;
    if(idle && safeFromHits){
      p.hp = Math.min(p.maxHp, p.hp + REGEN_HP*dt);
      p.mp = Math.min(p.maxMp, p.mp + REGEN_MP*dt);
    }

    if(p.attackId){
      const mo = monsters.get(p.attackId);
      if(!mo){ p.attackId = null; }
      else {
        const d = dist(p, mo);
        if(d > p.range + 10){
          p.x += (mo.x-p.x)/d * PLAYER_SPEED * dt;
          p.y += (mo.y-p.y)/d * PLAYER_SPEED * dt;
        } else if(now - p.lastAtk > ATTACK_CD){
          p.lastAtk = now;
          mo.hp -= p.atk;
          mo.aggroId = pid;
          mo.damage.set(pid, (mo.damage.get(pid)||0) + p.atk);
          grantExp(p, pid, p.atk);
          if(mo.hp <= 0) killMonster(p.attackId, mo, now);
        }
      }
    }
    else if(p.tx !== null){
      const d = Math.hypot(p.tx-p.x, p.ty-p.y);
      if(d > 4){ p.x += (p.tx-p.x)/d * PLAYER_SPEED * dt; p.y += (p.ty-p.y)/d * PLAYER_SPEED * dt; }
      else { p.tx = p.ty = null; }
    }
  }

  for(const [mid, mo] of monsters){
    const tgt = mo.aggroId ? players.get(mo.aggroId) : null;
    if(tgt && !tgt.respawnAt){
      const d = dist(mo, tgt);
      if(d > 600){ mo.aggroId = null; }
      else if(d > 22){
        const sp = (40 + mo.tier*14) * dt;
        mo.x += (tgt.x-mo.x)/d * sp; mo.y += (tgt.y-mo.y)/d * sp;
      } else if(now - mo.lastHitAt > 900){
        mo.lastHitAt = now;
        tgt.hp -= mo.atk;
        tgt.lastDamagedAt = now;
        if(tgt.hp <= 0){
          const drop = Math.floor(tgt.soul/2);
          tgt.soul -= drop;
          if(drop > 0){
            souls.set(nid('s'), { x:tgt.x, y:tgt.y, amount: drop, ownerId: null, unlockAt: now, expireAt: now+60000 });
          }
          tgt.respawnAt = now + 4000;
          send(tgt.ws, { t:'msg', k:'b', text:'쓰러졌다... 혼의 절반을 그 자리에 흘렸다 (4초 후 부활)' });
          mo.aggroId = null;
        }
      }
    } else {
      mo.wander += (Math.random()-0.5)*0.4;
      mo.x = Math.max(30, Math.min(WORLD-30, mo.x + Math.cos(mo.wander)*18*dt));
      mo.y = Math.max(30, Math.min(WORLD-30, mo.y + Math.sin(mo.wander)*18*dt));
    }
  }

  for(const [sid, s] of souls){ if(now > s.expireAt) souls.delete(sid); }

  broadcast({ t:'state', now,
    players: [...players.entries()].map(([pid,p]) => ({
      id: pid, name: p.name, x: Math.round(p.x), y: Math.round(p.y),
      hp: Math.round(p.hp), maxHp: p.maxHp, mp: Math.round(p.mp), maxMp: p.maxMp,
      level: p.level, exp: p.exp, expNeed: expNeed(p.level),
      soul: p.soul, dead: p.respawnAt > now })),
    monsters: [...monsters.entries()].map(([mid,m]) => ({
      id: mid, x: Math.round(m.x), y: Math.round(m.y), hp: m.hp, maxHp: m.maxHp, tier: m.tier })),
    souls: [...souls.entries()].map(([sid,s]) => ({
      id: sid, x: Math.round(s.x), y: Math.round(s.y), amount: s.amount,
      locked: now < s.unlockAt, ownerId: s.ownerId })),
  });
}, TICK);

function killMonster(mid, mo, now){
  let topPid = null, topDmg = -1;
  for(const [pid, dmg] of mo.damage){
    if(dmg > topDmg){ topDmg = dmg; topPid = pid; }
  }
  const amount = mo.tier * 5;
  souls.set(nid('s'), {
    x: mo.x, y: mo.y, amount,
    ownerId: topPid,
    unlockAt: now + SOUL_PRIORITY_MS,
    expireAt: now + 60000,
  });
  monsters.delete(mid);
  setTimeout(spawnMonster, 3000 + rnd(4000));
}

httpServer.listen(PORT, () => console.log(`[魂] 세계 가동 — http://localhost:${PORT}`));
