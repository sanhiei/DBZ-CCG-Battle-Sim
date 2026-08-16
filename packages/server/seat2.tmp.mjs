import { WebSocket } from 'ws';
const cards = (await (await fetch('http://127.0.0.1:8787/api/cards')).json()).cards;
function lv(n){const l=cards.filter(c=>c.rules?.personality?.personalityName===n&&c.rules.personality.level).sort((a,b)=>a.rules.personality.level-b.rules.personality.level);const o=[];for(const c of l){if(c.rules.personality.level===o.length+1)o.push(c);}return o.slice(0,3);}
const names=[...new Set(cards.filter(c=>c.rules?.personality?.personalityName).map(c=>c.rules.personality.personalityName))];
const mp=names.map(n=>({n,lv:lv(n)})).filter(x=>x.lv.length===3)[1];
const f=cards.filter(c=>!c.rules?.personality&&!/dragon ball/i.test(c.name)&&!c.name.toLowerCase().includes(mp.n.toLowerCase()));
const life=[];let need=47;for(const c of f){if(need<=0)break;const q=Math.min(3,need);life.push({cardId:c.id,qty:q});need-=q;}
const ws=new WebSocket('ws://127.0.0.1:8787');await new Promise(r=>ws.on('open',r));
ws.on('message',raw=>{const m=JSON.parse(String(raw));if(m.kind==='error')console.log('ERR',m.message);if(m.kind==='state')console.log('opponent sees game START');});
ws.send(JSON.stringify({kind:'join',roomCode:'BUILD',playerName:'Opponent'}));
await new Promise(r=>setTimeout(r,300));
ws.send(JSON.stringify({kind:'action',action:{type:'loadDeck',playerIdx:1,deck:{name:'Opp Deck',mpLevels:mp.lv.map(c=>c.id),life},clientActionId:'d'}}));
await new Promise(r=>setTimeout(r,300));
ws.send(JSON.stringify({kind:'action',action:{type:'setReady',playerIdx:1,clientActionId:'r'}}));
console.log('seat 1 ready in room BUILD, waiting for you...');
await new Promise(r=>setTimeout(r,120000));
