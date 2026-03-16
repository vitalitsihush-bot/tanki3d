'use strict';
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ─── GAME CONSTANTS (must match client) ───────────────────────────────────────
const HALF=18, SPOFF=13;
const TSPD=7, BSPD=16, FCD=0.55, BDMG=30, TICK_HZ=30;
const COLS=[0x00ffaa,0xff3355,0x4488ff,0xffdd00];
const SPAWNS=[[-SPOFF,-SPOFF,Math.PI*.25],[SPOFF,SPOFF,-Math.PI*.75],[SPOFF,-SPOFF,Math.PI*.75],[-SPOFF,SPOFF,-Math.PI*.25]];
const OBS=[[-6,-6,1.5,1.5],[6,-6,1.5,1.5],[-6,6,1.5,1.5],[6,6,1.5,1.5],[0,-10,2,.9],[0,10,2,.9],[-10,0,.9,2],[10,0,.9,2],[0,0,2.2,2.2],[-4,-4,.9,.9],[4,-4,.9,.9],[-4,4,.9,.9],[4,4,.9,.9]];

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function hitWall(x,z,r){
  if(Math.abs(x)>HALF-r||Math.abs(z)>HALF-r)return true;
  for(const[ox,oz,hw,hd]of OBS)if(x+r>ox-hw&&x-r<ox+hw&&z+r>oz-hd&&z-r<oz+hd)return true;
  return false;
}
function sanitize(n){return(n||'').replace(/[<>"&]/g,'').trim().slice(0,12)||'Игрок';}
function rcode(){return Array.from({length:4},()=>'ABCDEFGHJKLMNPQRSTUVWXYZ2345678'[Math.random()*31|0]).join('');}
function mkTank(idx){
  const[sx,sz,sa]=SPAWNS[idx%4];
  return{x:sx,z:sz,a:sa,ta:sa,vx:0,vz:0,hp:100,alive:true,col:COLS[idx],kills:0,cd:0};
}

// ─── ROOMS ────────────────────────────────────────────────────────────────────
const rooms=new Map(); // code → room

function createRoom(playerId, ws, nick){
  let code; do{code=rcode();}while(rooms.has(code));
  const room={
    code,
    order:[playerId],
    nicks:{[playerId]:nick},
    sockets:new Map([[playerId,ws]]),
    inputs:new Map([[playerId,{}]]),
    started:false, state:null, loop:null
  };
  rooms.set(code,room);
  return room;
}

function lobbyMsg(room){
  const p=room.order.map((id,i)=>({id,name:room.nicks[id]||'Игрок',col:'#'+COLS[i].toString(16).padStart(6,'0')}));
  return{t:'lobby',p,n:room.nicks,leader:room.order[0]};
}
function bcast(room,msg){
  const d=JSON.stringify(msg);
  for(const ws of room.sockets.values())if(ws.readyState===1)ws.send(d);
}
function wsend(ws,msg){if(ws.readyState===1)ws.send(JSON.stringify(msg));}

// ─── GAME TICK ────────────────────────────────────────────────────────────────
function tick(room,dt){
  const s=room.state;
  let expl=null, newKills=[];

  for(const pid of room.order){
    const t=s.tanks[pid]; if(!t||!t.alive)continue;
    const inp=room.inputs.get(pid)||{};
    let vx=0,vz=0;
    if(inp.dx||inp.dz){
      const len=Math.hypot(inp.dx,inp.dz)||1,nx=inp.dx/len,nz=inp.dz/len;
      const ex=t.x+nx*TSPD*dt,ez=t.z+nz*TSPD*dt;
      if(!hitWall(ex,t.z,.88)){t.x=clamp(ex,-HALF+1,HALF-1);vx=nx*TSPD;}
      if(!hitWall(t.x,ez,.88)){t.z=clamp(ez,-HALF+1,HALF-1);vz=nz*TSPD;}
      t.a=Math.atan2(nx,nz)+Math.PI;
    }
    t.vx=vx; t.vz=vz;
    t.ta=inp.ta!=null?inp.ta:t.a;
    t.cd=Math.max(0,(t.cd||0)-dt);
    if(inp.fire&&t.cd<=0){
      const a=t.ta;
      s.bullets.push({id:'b'+(s.seq++),own:pid,x:t.x-Math.sin(a)*1.15,z:t.z-Math.cos(a)*1.15,dx:-Math.sin(a),dz:-Math.cos(a),life:2.5});
      t.cd=FCD;
    }
  }

  for(let i=s.bullets.length-1;i>=0;i--){
    const b=s.bullets[i];
    b.x+=b.dx*BSPD*dt; b.z+=b.dz*BSPD*dt; b.life-=dt;
    let dead=b.life<=0||hitWall(b.x,b.z,.22);
    if(!dead){
      for(const pid of room.order){
        const t=s.tanks[pid]; if(!t||!t.alive||pid===b.own)continue;
        if(Math.hypot(b.x-t.x,b.z-t.z)<1.05){
          t.hp-=BDMG;
          if(t.hp<=0){t.hp=0;t.alive=false;newKills.push({killer:b.own,victim:pid});const kt=s.tanks[b.own];if(kt)kt.kills=(kt.kills||0)+1;}
          expl=[b.x,b.z]; dead=true; break;
        }
      }
    }
    if(dead)s.bullets.splice(i,1);
  }

  const living=room.order.filter(p=>s.tanks[p]?.alive);
  const over=room.order.length>1&&living.length<=1;
  return{expl,newKills,winner:over?(living[0]||null):undefined};
}

function startRoom(room){
  if(room.loop){clearInterval(room.loop);room.loop=null;}
  room.started=true;
  const state={tanks:{},bullets:[],seq:0};
  room.order.forEach((id,i)=>{state.tanks[id]=mkTank(i);});
  room.state=state;
  room.inputs.forEach((_,pid)=>room.inputs.set(pid,{}));

  bcast(room,{t:'start',s:state,o:room.order,n:room.nicks});

  let last=Date.now();
  room.loop=setInterval(()=>{
    const now=Date.now(), dt=Math.min((now-last)/1000,.1); last=now;
    const{expl,newKills,winner}=tick(room,dt);
    bcast(room,{t:'state',s:room.state,expl,nk:newKills.length?newKills:undefined});
    if(winner!==undefined){
      bcast(room,{t:'over',w:winner});
      clearInterval(room.loop); room.loop=null; room.started=false;
    }
  },1000/TICK_HZ);
}

// ─── WS SERVER ────────────────────────────────────────────────────────────────
const server=http.createServer((req,res)=>{
  if(req.method==='GET'&&(req.url==='/'||req.url==='/index.html')){
    const file=path.join(__dirname,'tanki3d.html');
    fs.readFile(file,(err,data)=>{
      if(err){res.writeHead(404);res.end('tanki3d.html not found');return;}
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(data);
    });
  } else {
    res.writeHead(200);res.end('Tanki3D OK');
  }
});
const wss=new WebSocketServer({server});

wss.on('connection',ws=>{
  let roomCode=null, myId=null;

  ws.on('message',raw=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}

    if(msg.t==='create'){
      myId='p'+Math.random().toString(36).slice(2,9);
      const room=createRoom(myId,ws,sanitize(msg.nick));
      roomCode=room.code;
      wsend(ws,{t:'created',code:room.code,id:myId});
      bcast(room,lobbyMsg(room));
    }

    else if(msg.t==='join'){
      const code=(msg.code||'').toUpperCase().trim();
      const room=rooms.get(code);
      if(!room){wsend(ws,{t:'err',m:'Комната не найдена'});return;}
      if(room.started){wsend(ws,{t:'err',m:'Игра уже идёт'});return;}
      if(room.order.length>=4){wsend(ws,{t:'err',m:'Комната полная'});return;}
      myId='p'+Math.random().toString(36).slice(2,9);
      roomCode=code;
      room.order.push(myId);
      room.nicks[myId]=sanitize(msg.nick);
      room.sockets.set(myId,ws);
      room.inputs.set(myId,{});
      wsend(ws,{t:'joined',code,id:myId});
      bcast(room,lobbyMsg(room));
    }

    else if(msg.t==='start'){
      const room=rooms.get(roomCode); if(!room||room.order[0]!==myId)return;
      if(room.order.length<1)return;
      startRoom(room);
    }

    else if(msg.t==='inp'){
      const room=rooms.get(roomCode); if(!room)return;
      room.inputs.set(myId,{dx:+msg.dx||0,dz:+msg.dz||0,fire:!!msg.fire,ta:msg.ta??null});
    }

    else if(msg.t==='rematch'){
      const room=rooms.get(roomCode); if(!room||room.order[0]!==myId)return;
      if(room.loop){clearInterval(room.loop);room.loop=null;}
      bcast(room,{t:'rematch_cd'});
      let n=3;
      const cd=setInterval(()=>{
        n--; bcast(room,{t:'cd',n});
        if(n<=0){clearInterval(cd); if(rooms.has(roomCode))startRoom(room);}
      },1000);
    }
  });

  ws.on('close',()=>{
    if(!roomCode||!myId)return;
    const room=rooms.get(roomCode); if(!room)return;
    room.sockets.delete(myId);
    room.inputs.delete(myId);
    if(room.sockets.size===0){
      if(room.loop)clearInterval(room.loop);
      rooms.delete(roomCode); return;
    }
    if(room.started&&room.state?.tanks[myId]){
      room.state.tanks[myId].alive=false;
    } else {
      room.order=room.order.filter(id=>id!==myId);
      delete room.nicks[myId];
    }
    bcast(room,lobbyMsg(room));
  });
});

server.listen(PORT,()=>console.log(`Tanki3D listening on :${PORT}`));
